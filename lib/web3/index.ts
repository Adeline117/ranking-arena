/**
 * Web3 Module — Barrel Export
 *
 * Re-exports all Web3 utilities for convenient imports.
 *
 * NOTE: wagmiConfig / targetChain / Web3Provider are client-only.
 * Server routes should import CONTRACT_ADDRESSES / ARENA_SCORE_SCHEMA_UID
 * directly from '@/lib/web3/contracts'.
 */

// Server-safe constants and shared client
export { CONTRACT_ADDRESSES, ARENA_SCORE_SCHEMA_UID, basePublicClient, baseChain, baseRpcUrl } from './contracts'

// Client-only (wagmi/RainbowKit) — tree-shaken if not imported
export { wagmiConfig, targetChain } from './config'
export { Web3Provider } from './provider'
export { useSiweAuth } from './useSiweAuth'
export { useOneClickSiwe, type OneClickStatus } from './useOneClickSiwe'
export { useWallet } from './useWallet'

// Server-safe utilities
export { checkNFTMembership, getNFTBalance, getTokenExpiry } from './nft'
export {
  publishAttestation,
  getAttestation,
  verifyAttestation,
  createDataHash,
  registerSchema,
  ARENA_SCORE_SCHEMA,
} from './eas'
export {
  getSpace,
  getProposals,
  getProposal,
  getVotes,
  hasVoted,
  getArenaSpaceId,
  getProposalUrl,
  getSpaceUrl,
} from './snapshot'

// Copy trading contract types and utilities
export {
  COPY_TRADING_ABI,
  COPY_TRADING_ADDRESSES,
  isCopyTradingAvailable,
  getCopyTradingAddress,
  calculateNetPnl,
  formatPosition,
  type CopyTradeStatus,
  type CopyTradeStrategy,
  type CopyTradePosition,
  type CopyTradeSubscription,
  type CopyTradeConfig,
} from './copy-trading'

// Multi-chain support
export {
  CHAIN_IDS,
  CHAIN_CONFIGS,
  getPublicClient,
  getDefaultChain,
  getSupportedChains,
  getProductionChains,
  isChainSupported,
  getChainConfig,
  getTxExplorerUrl,
  getAddressExplorerUrl,
  formatChainName,
  type SupportedChainId,
  type ChainConfig,
} from './multi-chain'
