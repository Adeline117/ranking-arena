/**
 * Webpack warnings for optional peers that are unreachable in Arena's wallet UI.
 *
 * Keep both the importing module and missing request constrained. A request-only
 * suppression would hide a future regression if Arena enables either connector.
 */
export function getOptionalWalletPeerWarningRules() {
  return [
    {
      module:
        /@privy-io[\\/]react-auth[\\/]dist[\\/](?:esm|cjs)[\\/]FiatOnrampScreen-[^\\/]+\.(?:mjs|js)$/,
      message: /Can't resolve ['"]@stripe[\\/]crypto['"]/,
    },
    {
      module: /@wagmi[\\/]connectors[\\/]dist[\\/]esm[\\/]coinbaseWallet\.js$/,
      message: /Can't resolve ['"]@coinbase[\\/]wallet-sdk['"]/,
    },
    {
      module: /@wagmi[\\/]connectors[\\/]dist[\\/]esm[\\/]baseAccount\.js$/,
      message: /Can't resolve ['"]@base-org[\\/]account['"]/,
    },
    {
      module: /@wagmi[\\/]connectors[\\/]dist[\\/]esm[\\/]metaMask\.js$/,
      message: /Can't resolve ['"]@metamask[\\/]connect-evm['"]/,
    },
    {
      module: /@wagmi[\\/]connectors[\\/]dist[\\/]esm[\\/]safe\.js$/,
      message: /Can't resolve ['"]@safe-global[\\/]safe-apps-sdk['"]/,
    },
    {
      module: /@wagmi[\\/]connectors[\\/]dist[\\/]esm[\\/]safe\.js$/,
      message: /Can't resolve ['"]@safe-global[\\/]safe-apps-provider['"]/,
    },
  ]
}
