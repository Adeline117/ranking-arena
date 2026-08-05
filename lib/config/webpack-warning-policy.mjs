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

/**
 * Reviewed transitive warnings for code paths Arena cannot activate.
 *
 * ox's Tempo virtual master pool selects worker_threads through an expression.
 * Privy's viem barrel makes webpack parse that module even though Arena exposes
 * no Tempo chain or connector. Keep this rule pinned to the exact nested module
 * and exact warning; the repository source policy separately rejects direct
 * Tempo activation.
 */
export function getReviewedThirdPartyWarningRules() {
  return [
    {
      module:
        /node_modules[\\/]viem[\\/]node_modules[\\/]ox[\\/]_esm[\\/]tempo[\\/]internal[\\/]virtualMasterPool\.js$/,
      message: /^Critical dependency: the request of a dependency is an expression$/,
    },
  ]
}
