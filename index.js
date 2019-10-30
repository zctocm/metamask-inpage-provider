const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const ObservableStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const { inherits } = require('util')
const SafeEventEmitter = require('safe-event-emitter')
const dequal = require('fast-deep-equal')

const messages = require('./messages')
const { sendSiteMetadata } = require('./siteMetadata')
const {
  createErrorMiddleware,
  logStreamDisconnectWarning,
  promiseCallback,
} = require('./utils')

module.exports = MetamaskInpageProvider

inherits(MetamaskInpageProvider, SafeEventEmitter)

function MetamaskInpageProvider (connectionStream) {
  const self = this

  // private state
  self._sentWarnings = {
    enable: false,
    sendAsync: false,
    sendSync: false,
    signTypedData: false,
  }
  self._sentSiteMetadata = false
  self._isConnected = undefined
  self._accounts = []

  // public state
  self.selectedAddress = null
  self.networkVersion = undefined
  self.chainId = undefined

  // super constructor
  SafeEventEmitter.call(self)

  // setup connectionStream multiplexing
  const mux = self.mux = new ObjectMultiplex()
  pump(
    connectionStream,
    mux,
    connectionStream,
    self._handleDisconnect.bind(self, 'MetaMask')
  )

  // subscribe to metamask public config (one-way)
  self.publicConfigStore = new ObservableStore({ storageKey: 'MetaMask-Config' })

  // chainChanged and networkChanged events
  self.publicConfigStore.subscribe(function (state) {

    // Emit chainChanged event on chain change
    if ('chainId' in state && state.chainId !== self.chainId) {
      self.chainId = state.chainId
      self.emit('chainChanged', self.chainId)
    }

    // Emit networkChanged event on network change
    if ('networkVersion' in state && state.networkVersion !== self.networkVersion) {
      self.networkVersion = state.networkVersion
      self.emit('networkChanged', self.networkVersion)
    }
  })

  pump(
    mux.createStream('publicConfig'),
    asStream(self.publicConfigStore),
    // RPC requests should still work if only this stream fails
    logStreamDisconnectWarning.bind(self, 'MetaMask PublicConfigStore')
  )

  // ignore phishing warning message (handled elsewhere)
  mux.ignoreStream('phishing')

  // setup own event listeners

  // EIP-1193 subscriptions
  self.on('data', (error, { method, params }) => {
    if (!error && method === 'eth_subscription') {
      self.emit('notification', params.result)
    }
  })

  // EIP-1193 connect
  self.on('connect', () => {
    self._isConnected = true
  })

  // connect to async provider

  const jsonRpcConnection = createJsonRpcStream()
  pump(
    jsonRpcConnection.stream,
    mux.createStream('provider'),
    jsonRpcConnection.stream,
    self._handleDisconnect.bind(self, 'MetaMask RpcProvider')
  )

  // handle RPC requests via dapp-side rpc engine
  const rpcEngine = new RpcEngine()
  rpcEngine.push(createIdRemapMiddleware())
  rpcEngine.push(createErrorMiddleware())
  rpcEngine.push(jsonRpcConnection.middleware)
  self.rpcEngine = rpcEngine

  // json rpc notification listener
  jsonRpcConnection.events.on('notification', payload => {
    if (payload.method === 'wallet_accountsChanged') {
      self._handleAccountsChanged(payload.result)
    } else {
      self.emit('data', null, payload)
    }
  })

  // Work around for https://github.com/metamask/metamask-extension/issues/5459
  // drizzle accidentally breaking the `this` reference
  self.enable = self.enable.bind(self)
  self.send = self.send.bind(self)
  self.sendAsync = self.sendAsync.bind(self)
  self._sendAsync = self._sendAsync.bind(self)
  self._requestAccounts = self._requestAccounts.bind(self)

  // indicate that we've connected, for EIP-1193 compliance
  setTimeout(() => self.emit('connect'))
}

MetamaskInpageProvider.prototype.isMetaMask = true

/**
 * Returns whether the inpage provider is connected to MetaMask.
 */
MetamaskInpageProvider.prototype.isConnected = function () {
  return self._isConnected
}

/**
 * Sends an RPC request to MetaMask. Resolves to the result of the method call.
 * May reject with an error that must be caught by the caller.
 * 
 * @param {(string|Object)} methodOrPayload - The method name, or the RPC request object.
 * @param {Array<any>} [params] - If given a method name, the method's parameters.
 * @returns {Promise<any>} - A promise resolving to the result of the method call.
 */
MetamaskInpageProvider.prototype.send = function (methodOrPayload, params) {
  const self = this

  // construct payload object
  let payload
  if (params !== undefined) {

    // wrap params in array out of kindness
    if (!Array.isArray(params)) {
      params = [params]
    }

    // method must be a string if params were supplied
    // we will throw further down if it isn't
    payload = {
      method: methodOrPayload,
      params,
    }
  } else {
    if (typeof methodOrPayload === 'string') {
      payload = {
        method: methodOrPayload,
        params,
      }
    } else {

      payload = methodOrPayload

      // backwards compatibility: "synchronous" methods -.-
      if ([
        'eth_accounts',
        'eth_coinbase',
        'eth_uninstallFilter',
        'net_version',
      ].includes(payload.method)) {
        return self._sendSync(payload)
      }
    }
  }

  // typecheck payload and payload.method
  if (
    Array.isArray(payload) ||
    typeof payload !== 'object' ||
    typeof payload.method !== 'string'
  ) {
    throw new Error(messages.errors.invalidParams(), payload)
  }

  // specific handler for this method
  if (payload.method === 'eth_requestAccounts') {
    return self._requestAccounts()
  }

  return new Promise((resolve, reject) => {
    try {
      self._sendAsync(
        payload,
        promiseCallback(resolve, reject)
      )
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Backwards compatibility. Equivalent to: ethereum.send('eth_requestAccounts')
 * 
 * @returns {Promise<Array<string>>} - A promise that resolves to an array of addresses.
 */
MetamaskInpageProvider.prototype.enable = function () {
  const self = this
  if (!self._sentWarnings.enable) {
    console.warn(messages.warnings.enableDeprecation)
    self._sentWarnings.enable = true
  }
  return self._requestAccounts()
}

/**
 * TO BE DEPRECATED.
 * Backwards compatibility. ethereum.send() with callback.
 * 
 * @param {Object} payload - The RPC request object.
 * @param {Function} callback - The callback function.
 */
MetamaskInpageProvider.prototype.sendAsync = function (payload, cb) {
  const self = this

  if (!self._sentWarnings.sendAsync) {
    console.warn(messages.warnings.sendAsyncDeprecation)
    self._sentWarnings.sendAsync = true
  }
  self._sendAsync(payload, cb)
}

/**
 * Internal backwards compatibility method.
 */
MetamaskInpageProvider.prototype._sendSync = function (payload) {
  const self = this

  if (!self._sentWarnings.sendSync) {
    console.warn(messages.warnings.sendSyncDeprecation)
    self._sentWarnings.sendSync = true
  }

  let result
  switch (payload.method) {

    case 'eth_accounts':
      result = self.selectedAddress ? [self.selectedAddress] : []
      break

    case 'eth_coinbase':
      result = self.selectedAddress || null
      break

    case 'eth_uninstallFilter':
      self.sendAsync(payload, () => {})
      result = true
      break

    case 'net_version':
      result = self.networkVersion || null
      break

    default:
      throw new Error(messages.errors.unsupportedSync(payload.method))
  }

  return {
    id: payload.id,
    jsonrpc: payload.jsonrpc,
    result,
  }
}

/**
 * Internal method for calling EIP-1102 eth_requestAccounts.
 * Attempts to call eth_accounts before requesting the permission.
 */
MetamaskInpageProvider.prototype._requestAccounts = function () {
  const self = this

  return new Promise((resolve, reject) => {
    self._sendAsync(
      {
        method: 'eth_accounts',
      },
      promiseCallback(resolve, reject)
    )
  })
  .then(result => {
    if (
      !Array.isArray(result) ||
      result.length === 0
    ) {
      return new Promise((resolve, reject) => {
        self._sendAsync(
          {
            jsonrpc: '2.0',
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
          },
          promiseCallback(resolve, reject)
        )
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          self._sendAsync(
            {
              method: 'eth_accounts',
            },
            promiseCallback(resolve, reject)
          )
        })
      })
    } else {
      return result
    }
  })
  .catch(err => console.error(err))
}

/**
 * Internal RPC method. Forwards requests to background via the RPC engine.
 * Also remap ids inbound and outbound.
 */
MetamaskInpageProvider.prototype._sendAsync = function (payload, userCallback) {
  const self = this
  let cb = userCallback

  if (!payload.jsonrpc) {
    payload.jsonrpc = '2.0'
  }

  if (!self._sentSiteMetadata) {
    sendSiteMetadata(self.rpcEngine)
    self._sentSiteMetadata = true
  }

  if (
    payload.method === 'eth_signTypedData' &&
    !self._sentWarnings.signTypedData
  ) {
    console.warn(messages.warnings.signTypedDataDeprecation)
    self._sentWarnings.signTypedData = true

  } else if (payload.method === 'eth_accounts') {

    // legacy eth_accounts behavior
    cb = (err, res) => {
      if (err) {
        const code = err.code || res.error.code
        if (code === 4100) { // if error is unauthorized
          delete res.error
          res.result = []
        }
      }
      self._handleAccountsChanged(res.result || [])
      userCallback(err, res)
    }
  }

  self.rpcEngine.handle(payload, cb)
}

/**
 * Called when connection is lost to critical streams.
 */
MetamaskInpageProvider.prototype._handleDisconnect = function (streamName, err) {
  const self = this
  logStreamDisconnectWarning(streamName, err)
  if (self._isConnected) {
    self.emit('close', {
      code: 1011,
      reason: 'MetaMask background communication error.',
    })
  }
  self._isConnected = false
}

/**
 * Called when accounts may have changed.
 */
MetamaskInpageProvider.prototype._handleAccountsChanged = function (accounts) {

  // defensive programming
  if (!Array.isArray(accounts)) {
    console.error(
      'MetaMask: Received non-array accounts parameter. Please report this bug.',
      accounts
    )
    accounts = []
  }

  // emit accountsChanged if anything about the accounts array has changed
  if (!dequal(self._accounts, accounts)) {
    this.emit('accountsChanged', accounts)
    self._accounts = accounts
  }

  // handle selectedAddress
  if (this.selectedAddress !== accounts[0]) {
    this.selectedAddress = accounts[0] || null
  }
}
