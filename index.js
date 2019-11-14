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
const { ethErrors } = require('eth-json-rpc-errors')

const messages = require('./src/messages')
const { sendSiteMetadata } = require('./src/siteMetadata')
const {
  createErrorMiddleware,
  logStreamDisconnectWarning,
} = require('./src/utils')
const connectCapnode = require('./src/connectCapnode')

// resolve response.result, reject errors
const rpcPromiseCallback = (resolve, reject) => (error, response) => {
  error || response.error
  ? reject(error || response.error)
  : Array.isArray(response)
    ? resolve(response)
    : resolve(response.result)
}

module.exports = MetamaskInpageProvider

inherits(MetamaskInpageProvider, SafeEventEmitter)

// private state, kept here in part for use in the _metamask proxy
const _state = {

  sentWarnings: {
    enable: false,
    experimentalMethods: false,
    isConnected: false,
    sendAsync: false,
    signTypedData: false,
  },
  sentSiteMetadata: false,
  isConnected: undefined,
  accounts: [],
  isUnlocked: false,
}

function MetamaskInpageProvider (connectionStream) {

  // super constructor
  SafeEventEmitter.call(this)

  this._metamask = getExperimentalApi(this)

  // public state
  this.selectedAddress = null
  this.networkVersion = undefined
  this.chainId = undefined

  // setup connectionStream multiplexing
  const mux = this.mux = new ObjectMultiplex()
  pump(
    connectionStream,
    mux,
    connectionStream,
    this._handleDisconnect.bind(this, 'MetaMask'),
  )

  // subscribe to metamask public config (one-way)
  this.publicConfigStore = new ObservableStore({ storageKey: 'MetaMask-Config' })

  // chainChanged and networkChanged events
  this.publicConfigStore.subscribe(function (state) {

    if ('isUnlocked' in state && state.isUnlocked !== _state.isUnlocked) {
      _state.isUnlocked = state.isUnlocked
    }

    // Emit chainChanged event on chain change
    if ('chainId' in state && state.chainId !== this.chainId) {
      this.chainId = state.chainId
      this.emit('chainChanged', this.chainId)
    }

    // Emit networkChanged event on network change
    if ('networkVersion' in state && state.networkVersion !== this.networkVersion) {
      this.networkVersion = state.networkVersion
      this.emit('networkChanged', this.networkVersion)
    }
  })

  const capStream = mux.createStream('cap')
  const [capnode, capRemote] = connectCapnode()
  pump(
    capRemote,
    capStream,
    capRemote,
    (err) => {
      console.error('Problem with cap stream', err)
    }
  )

  this.requestIndex = () => {
    return capnode.requestIndex(capRemote)
  }

  pump(
    mux.createStream('publicConfig'),
    asStream(this.publicConfigStore),
    // RPC requests should still work if only this stream fails
    logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore'),
  )

  // ignore phishing warning message (handled elsewhere)
  mux.ignoreStream('phishing')

  // setup own event listeners

  // EIP-1193 subscriptions
  this.on('data', (error, { method, params }) => {
    if (!error && method === 'eth_subscription') {
      this.emit('notification', params.result)
    }
  })

  // EIP-1193 connect
  this.on('connect', () => {
    _state.isConnected = true
  })

  // connect to async provider

  const jsonRpcConnection = createJsonRpcStream()
  pump(
    jsonRpcConnection.stream,
    mux.createStream('provider'),
    jsonRpcConnection.stream,
    this._handleDisconnect.bind(this, 'MetaMask RpcProvider'),
  )

  // handle RPC requests via dapp-side rpc engine
  const rpcEngine = new RpcEngine()
  rpcEngine.push(createIdRemapMiddleware())
  rpcEngine.push(createErrorMiddleware())
  rpcEngine.push(jsonRpcConnection.middleware)
  this.rpcEngine = rpcEngine

  // json rpc notification listener
  jsonRpcConnection.events.on('notification', payload => {
    if (payload.method === 'wallet_accountsChanged') {
      this._handleAccountsChanged(payload.result)
    } else {
      this.emit('data', null, payload)
    }
  })

  // indicate that we've connected, for EIP-1193 compliance
  setTimeout(() => this.emit('connect'))
}

MetamaskInpageProvider.prototype.isMetaMask = true

/**
 * Deprecated.
 * Returns whether the inpage provider is connected to MetaMask.
 */
MetamaskInpageProvider.prototype.isConnected = function () {

  if (!_state.sentWarnings.isConnected) {
    console.warn(messages.warnings.isConnectedDeprecation)
    _state.sentWarnings.isConnected = true
  }
  return _state.isConnected
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
    }
  }

  // typecheck payload and payload.method
  if (
    Array.isArray(payload) ||
    typeof payload !== 'object' ||
    typeof payload.method !== 'string'
  ) {
    throw ethErrors.rpc.invalidRequest({
      message: messages.errors.invalidParams(), data: payload,
    })
  }

  // specific handler for this method
  if (payload.method === 'eth_requestAccounts') {
    return this._requestAccounts()
  }

  return new Promise((resolve, reject) => {
    try {
      this._sendAsync(
        payload,
        rpcPromiseCallback(resolve, reject),
      )
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Deprecated.
 * Equivalent to: ethereum.send('eth_requestAccounts')
 *
 * @returns {Promise<Array<string>>} - A promise that resolves to an array of addresses.
 */
MetamaskInpageProvider.prototype.enable = function () {

  if (!_state.sentWarnings.enable) {
    console.warn(messages.warnings.enableDeprecation)
    _state.sentWarnings.enable = true
  }
  return this._requestAccounts()
}

/**
 * Deprecated.
 * Backwards compatibility. ethereum.send() with callback.
 *
 * @param {Object} payload - The RPC request object.
 * @param {Function} callback - The callback function.
 */
MetamaskInpageProvider.prototype.sendAsync = function (payload, cb) {

  if (!_state.sentWarnings.sendAsync) {
    console.warn(messages.warnings.sendAsyncDeprecation)
    _state.sentWarnings.sendAsync = true
  }
  this._sendAsync(payload, cb)
}

/**
 * Internal method for calling EIP-1102 eth_requestAccounts.
 * Attempts to call eth_accounts before requesting the permission.
 */
MetamaskInpageProvider.prototype._requestAccounts = function () {

  return new Promise((resolve, reject) => {
    this._sendAsync(
      {
        method: 'eth_accounts',
      },
      rpcPromiseCallback(resolve, reject),
    )
  })
  .then(result => {
    if (
      !Array.isArray(result) ||
      result.length === 0
    ) {
      return new Promise((resolve, reject) => {
        this._sendAsync(
          {
            jsonrpc: '2.0',
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
          },
          rpcPromiseCallback(resolve, reject),
        )
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          this._sendAsync(
            {
              method: 'eth_accounts',
            },
            rpcPromiseCallback(resolve, reject),
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

  let cb = userCallback

  if (!_state.sentSiteMetadata) {
    sendSiteMetadata(this.rpcEngine)
    _state.sentSiteMetadata = true
  }

  if (!Array.isArray(payload)) {

    if (!payload.jsonrpc) {
      payload.jsonrpc = '2.0'
    }

    if (
      payload.method === 'eth_signTypedData' &&
      !_state.sentWarnings.signTypedData
    ) {
      console.warn(messages.warnings.signTypedDataDeprecation)
      _state.sentWarnings.signTypedData = true

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
        this._handleAccountsChanged(res.result || [])
        userCallback(err, res)
      }
    }
  }

  this.rpcEngine.handle(payload, cb)
}

/**
 * Called when connection is lost to critical streams.
 */
MetamaskInpageProvider.prototype._handleDisconnect = function (streamName, err) {

  logStreamDisconnectWarning.bind(this)(streamName, err)
  if (_state.isConnected) {
    this.emit('close', {
      code: 1011,
      reason: 'MetaMask background communication error.',
    })
  }
  _state.isConnected = false
}

/**
 * Called when accounts may have changed.
 */
MetamaskInpageProvider.prototype._handleAccountsChanged = function (accounts) {

  // defensive programming
  if (!Array.isArray(accounts)) {
    console.error(
      'MetaMask: Received non-array accounts parameter. Please report this bug.',
      accounts,
    )
    accounts = []
  }

  // emit accountsChanged if anything about the accounts array has changed
  if (!dequal(_state.accounts, accounts)) {
    this.emit('accountsChanged', accounts)
    _state.accounts = accounts
  }

  // handle selectedAddress
  if (this.selectedAddress !== accounts[0]) {
    this.selectedAddress = accounts[0] || null
  }
}

/**
 * Gets experimental _metamask API as Proxy.
 */
function getExperimentalApi (instance) {
  return new Proxy(
    {

      /**
       * Determines if MetaMask is unlocked by the user.
       *
       * @returns {Promise<boolean>} - Promise resolving to true if MetaMask is currently unlocked
       */
      isUnlocked: async () => {
        return _state.isUnlocked
      },

      /**
       * Make a batch request.
       */
      sendBatch: async (requests) => {

        // basic input validation
        if (!Array.isArray(requests)) {
          throw ethErrors.rpc.invalidRequest({
            message: 'Batch requests must be made with an array of request objects.',
            data: requests,
          })
        }

        return new Promise((resolve, reject) => {
          try {
            instance._sendAsync(
              requests,
              rpcPromiseCallback(resolve, reject),
            )
          } catch (error) {
            reject(error)
          }
        })
      },
    },
    {

      get: (obj, prop) => {

        if (!_state.sentWarnings.experimentalMethods) {
          console.warn(messages.warnings.experimentalMethods)
          _state.sentWarnings.experimentalMethods = true
        }
        return obj[prop]
      },
    },
  )
}
