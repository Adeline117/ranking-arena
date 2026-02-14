/**
 * Multi-Chain module public API
 */

export {
  EVM_CHAINS,
  SUPPORTED_CHAIN_IDS,
  getChainConfig,
  getChainByShortName,
  isSupported,
  getChainsPublicInfo,
  type EVMChainConfig,
  type NativeCurrency,
} from './config'

export {
  getBalance,
  getTokenBalance,
  getTransactions,
  getPortfolio,
  type NativeBalance,
  type TokenBalance,
  type Transaction,
  type ChainPortfolio,
  type Portfolio,
} from './evm-adapter'

export {
  switchChain,
  addChain,
  getCurrentChainId,
  isOnSupportedChain,
  shortenAddress,
  getExplorerLink,
  buildAddChainParams,
} from './wallet-utils'
