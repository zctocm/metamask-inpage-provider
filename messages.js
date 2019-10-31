module.exports = {
  errors: {
    invalidParams: () => `The MetaMask Ethereum provider does not support your given parameters. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193`,
    unsupportedSync: method => `The MetaMask Web3 object does not support synchronous methods like ${method} without a callback parameter.`
  },
  warnings: {
    enableDeprecation: `MetaMask: ethereum.enable() is deprecated and may be removed in the future. Please use ethereum.send('eth_requestAccounts'). For more details, see: https://eips.ethereum.org/EIPS/eip-1102`,
    signTypedDataDeprecation: `MetaMask: ethereum.sendAsync(...) is deprecated and may be removed in the future. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193`,
    sendAsyncDeprecation: `MetaMask: This experimental version of eth_signTypedData will be deprecated in the next release in favor of the standard as defined in EIP-712. See https://git.io/fNzPl for more information on the new standard.`,
    sendSyncDeprecation: `MetaMask: ethereum.send(requestObject) will be Promise-returning for all methods starting December 9, 2019. For details, see: https://medium.com/metamask/deprecating-synchronous-provider-methods-82f0edbc874b`
  }
}
