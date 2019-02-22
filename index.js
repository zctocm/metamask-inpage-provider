const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createErrorMiddleware = require('./createErrorMiddleware')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const LocalStorageStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const util = require('util')
const SafeEventEmitter = require('safe-event-emitter')
const extend = require('xtend')
let isEnabled = false
let isConnected = false

module.exports = MetamaskInpageProvider

util.inherits(MetamaskInpageProvider, SafeEventEmitter)

function MetamaskInpageProvider (connectionStream) {
  const self = this
  self.selectedAddress = undefined
  self.networkVersion = undefined

  // super constructor
  SafeEventEmitter.call(self)

  // setup connectionStream multiplexing
  const mux = self.mux = new ObjectMultiplex()
  pump(
    connectionStream,
    mux,
    connectionStream,
    logStreamDisconnectWarning.bind(this, 'MetaMask')
  )

  // subscribe to metamask public config (one-way)
  self.publicConfigStore = new LocalStorageStore({ storageKey: 'MetaMask-Config' })

  // Emit events for some state changes
  self.publicConfigStore.subscribe(function (state) {
    if (!isConnected) {
      isConnected = true
      this.emit('connect')
    }

    // Emit accountsChanged event on account change
    if ('selectedAddress' in state && state.selectedAddress !== self.selectedAddress) {
      self.selectedAddress = state.selectedAddress
      self.emit('accountsChanged', [self.selectedAddress])
    }

    // Emit networkChanged event on network change
    if ('networkVersion' in state && state.networkVersion !== self.networkVersion) {
      self.networkVersion = state.networkVersion
      self.emit('networkChanged', state.networkVersion)
    }
  })

  pump(
    mux.createStream('publicConfig'),
    asStream(self.publicConfigStore),
    logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore')
  )

  // ignore phishing warning message (handled elsewhere)
  mux.ignoreStream('phishing')

  // connect to async provider
  const jsonRpcConnection = createJsonRpcStream()
  pump(
    jsonRpcConnection.stream,
    mux.createStream('provider'),
    jsonRpcConnection.stream,
    logStreamDisconnectWarning.bind(this, 'MetaMask RpcProvider')
  )

  // handle sendAsync requests via dapp-side rpc engine
  const rpcEngine = new RpcEngine()
  rpcEngine.push(createIdRemapMiddleware())
  rpcEngine.push(createErrorMiddleware())
  rpcEngine.push(jsonRpcConnection.middleware)
  self.rpcEngine = rpcEngine

  jsonRpcConnection.events.on('notification', (msg) => this.receive(msg))

  // Work around for https://github.com/metamask/metamask-extension/issues/5459
  // drizzle accidently breaking the `this` reference
  self.send = self.send.bind(self)
  self.sendAsync = self.sendAsync.bind(self)
}

MetamaskInpageProvider.prototype.receive = function (message) {

  try {
    const data = JSON.parse(message)

    // forward json rpc notifications
    if (data.method && data.method === 'eth_subscription') {
      return this.emit('data', null, message)
    }

    // Handle any other message types here.

  } catch (error) {
    // This message was not JSON, so we don't handle it here.
  }
}

// Web3 1.0 provider uses `send` with a callback for async queries
MetamaskInpageProvider.prototype.send = function (a, b) {
  if (typeof a === 'string' && !b || Array.isArray(b)) {
    return this.send2(a, b)
  }
  return this.sendAsync(a, b)
}

MetamaskInpageProvider.prototype.send2 = function (method, params = []) {
  if (method === 'eth_requestAccounts') return this.enable()

  return new Promise((resolve, reject) => {
    try {
      this.sendAsync({ method, params, beta: true }, (error, response) => {
        error = error || response.error
        error ? reject(error) : resolve(response)
      })
    } catch (error) {
      // Per EIP-1193, send should never throw, only reject its Promise. Here
      // we swallow thrown errors, which is safe since we handle them above.
    }
  })
}

// handle sendAsync requests via asyncProvider
// also remap ids inbound and outbound
MetamaskInpageProvider.prototype.sendAsync = function (payload, cb) {
  const self = this

  if (payload.method === 'eth_requestAccounts') {
    return this.enable()
  }

  this.rpcEngine.handle(payload, cb)
}

MetamaskInpageProvider.prototype._sendSync = function (payload) {
  const self = this

  let selectedAddress
  let result = null
  switch (payload.method) {

    case 'eth_accounts':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress
      result = selectedAddress ? [selectedAddress] : []
      break

    case 'eth_coinbase':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress
      result = selectedAddress || null
      break

    case 'eth_uninstallFilter':
      self.sendAsync(payload, noop)
      result = true
      break

    case 'net_version':
      const networkVersion = self.publicConfigStore.getState().networkVersion
      result = networkVersion || null
      break

    // throw not-supported Error
    default:
      var link = 'https://github.com/MetaMask/faq/blob/master/DEVELOPERS.md#dizzy-all-async---think-of-metamask-as-a-light-client'
      var message = `The MetaMask Web3 object does not support synchronous methods like ${payload.method} without a callback parameter. See ${link} for details.`
      throw new Error(message)

  }

  // return the result
  return {
    id: payload.id,
    jsonrpc: payload.jsonrpc,
    result: result,
  }
}

/*
 * Requests the user displays an account to the provider.
 * EIP 1102 compatibility.
 *
 * @returns {Promise<Array<string>>} accounts - An array of hex-prefixed Ethereum addresses that the user identifies as.
 */
MetamaskInpageProvider.prototype.enable = function (opts = {}) {
  return new Promise((resolve, reject) => {
    const defaultOpts = {
      method: 'wallet_requestPermissions',
      params: [{
        'eth_accounts': {},
      }],
    }

    const options = extend(opts, defaultOpts)

    this.sendAsync(options, (err, res) => {

      // A system error:
      if (err) {
        return reject(err)
      }

      // The user rejected the request:
      if (res.error && res.error.code === 5) {
        return reject(res.error)
      }

      if (res.error) {
        return reject({
          message: res.error,
          code: 4001,
        })
      }

      isEnabled = true
      this.getAccounts(this)
      .then(resolve)
      .catch(reject)
    })
  })
}

/**
 * Determines if MetaMask is unlocked by the user
 *
 * @returns {Promise<boolean>} - Promise resolving to true if MetaMask is currently unlocked
 */
MetamaskInpageProvider.prototype.isUnlocked = function () {
  // TODO: Verify if this is sufficient. Currently unclear the utility of Dapps knowing the unlock state.
  return this.isApproved
}

/**
 * Determines if this domain is currently enabled
 *
 * @returns {boolean} - true if this domain is currently enabled
 */
MetamaskInpageProvider.prototype.isEnabled = function () {
  return isEnabled
}

/**
 * Determines if this domain is currently connected to MetaMask
 *
 * @returns {boolean} - true if this domain is currently enabled
 */
MetamaskInpageProvider.prototype.isConnected = function () {
  return isConnected
}


/**
 * Determines if this domain has been previously approved
 *
 * @returns {Promise<boolean>} - Promise resolving to true if this domain has been previously approved
 */
MetamaskInpageProvider.prototype.isApproved = function () {
  return new Promise((resolve, reject) => {
    this.sendAsync({
      method: 'wallet_requestPermissions',
      params: [{
        readYourProfile: {},
        writeToYourProfile: {},
      }],
    }, (err, res) => {

      // A system error:
      if (err) {
        return reject(err)
      }

      // The user rejected the request:
      if (res.error && res.error.code === 5) {
        return reject(res.error)
      }

      this.getAccounts(this)
      .then(resolve)
      .catch(reject)
    })
  })
}

MetamaskInpageProvider.prototype._subscribe = function () {
  this.on('data', (error, { method, params }) => {
    if (!error && method === 'eth_subscription') {
      this.emit('notification', params.result)
    }
  })
}


MetamaskInpageProvider.prototype.getAccounts = function () {
  return new Promise((resolve, reject) => {
    this.sendAsync({
      method: 'eth_accounts',
      params: [],
    }, function (error, response) {
      if (error) {
        reject(error)
      }
      if (response.error) {
        reject(response.error)
      }
      const accounts = response.result
      resolve(accounts)
    })
  })
}

MetamaskInpageProvider.prototype.isMetaMask = true

// util

function logStreamDisconnectWarning (remoteLabel, err) {
  isConnected = false
  let warningMsg = `MetamaskInpageProvider - lost connection to ${remoteLabel}`
  if (err) warningMsg += '\n' + err.stack
  const listeners = this.listenerCount('error')
  if (listeners > 0) {
    this.emit('error', warningMsg)
  }
}

function noop () {}
