module.exports = {
  errors: {
    invalidParams: () => `Invalid request parameters. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193`,
  },
  warnings: {
    // deprecated stuff yet to be scheduled for removal
    enableDeprecation: `MetaMask: 'ethereum.enable()' is deprecated and may be removed in the future. Please use "ethereum.send('eth_requestAccounts')" instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1102`,
    isConnectedDeprecation: `MetaMask: 'ethereum.isConnected()' is deprecated and may be removed in the future. Please listen for the relevant events instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1193`,
    sendAsyncDeprecation: `MetaMask: 'ethereum.sendAsync(...)' is deprecated and may be removed in the future. Please use 'ethereum.send(method: string, params: Array<any>)' instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1193`,
    // misc
    experimentalMethods: `MetaMask: 'ethereum._metamask' exposes non-standard, experimental methods. They may be removed or changed without warning.`,
  },
}
