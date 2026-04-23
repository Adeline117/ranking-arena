// Shim for viem/tempo — wagmi@3.4.5 imports Actions.zone which doesn't
// exist in viem@2.47.17. Tempo (on-chain sessions) is unused by Arena.
// This shim provides empty exports so webpack doesn't fail.
module.exports = {
  Actions: {},
  Abis: {},
  Bytes: {},
  PublicKey: {},
  Secp256k1: {},
  TokenId: {},
}
