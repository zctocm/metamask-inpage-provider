module.exports = {
  errors: {
    invalidParams: () => `The MetaMask Ethereum provider does not support your given parameters. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193`,
    unsupportedSync: method => `The MetaMask Web3 object does not support synchronous methods like ${method} without a callback parameter.`
  },
  warnings: {
    // TODO:deprecate:2019-12-16
    autoReloadDeprecation: `MetaMask: MetaMask will stop reloading pages on network change on December 16, 2019. For more information, see: https://medium.com/metamask/no-longer-reloading-pages-on-network-change-fbf041942b44 \nSet 'ethereum.autoRefreshOnNetworkChange' to 'false' to silence this warning: https://metamask.github.io/metamask-docs/API_Reference/Ethereum_Provider#ethereum.autorefreshonnetworkchange`,
    sendSyncDeprecation: `MetaMask: 'ethereum.send(requestObject)' will be Promise-returning for all methods starting December 16, 2019. For more information, see: https://medium.com/metamask/deprecating-synchronous-provider-methods-82f0edbc874b`,
    // deprecated stuff yet to be removed
    enableDeprecation: `MetaMask: 'ethereum.enable()' is deprecated and may be removed in the future. Please use "ethereum.send('eth_requestAccounts')" instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1102`,
    sendAsyncDeprecation: `MetaMask: 'ethereum.sendAsync(...)' is deprecated and may be removed in the future. Please use 'ethereum.send(method: string, params: Array<any>)' instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1193`,
    signTypedDataDeprecation: `MetaMask: 'eth_signTypedData' is deprecated and may be removed in the future, in favor of EIP-712. For more information, see: https://git.io/fNzPl`,
    // misc
    experimentalMethods: `MetaMask: 'ethereum._metamask' exposes methods that have not been standardized yet. This means that these methods may not be implemented in other dapp browsers and may be removed from MetaMask in the future.`,
  }
}
