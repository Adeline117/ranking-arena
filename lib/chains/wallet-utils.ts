/**
 * Wallet Utility Functions
 *
 * Helper functions for chain switching and network management.
 * Does NOT modify existing RainbowKit/wagmi configuration.
 */

import { EVM_CHAINS, type EVMChainConfig } from './config'

// ── Types ──

interface AddEthereumChainParameter {
  chainId: string
  chainName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: string[]
  blockExplorerUrls: string[]
}

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

// ── Functions ──

/**
 * Build the parameter object for wallet_addEthereumChain.
 */
export function buildAddChainParams(config: EVMChainConfig): AddEthereumChainParameter {
  return {
    chainId: `0x${config.chainId.toString(16)}`,
    chainName: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: [config.explorerUrl],
  }
}

/**
 * Request the user's wallet to switch to a specific chain.
 * If the chain is not yet added, attempts to add it first.
 */
export async function switchChain(
  provider: EthereumProvider,
  chainId: number
): Promise<boolean> {
  const hexChainId = `0x${chainId.toString(16)}`

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    })
    return true
  } catch (err: unknown) {
    // Error code 4902: chain not added
    const code = (err as { code?: number }).code
    if (code === 4902) {
      return addChain(provider, chainId)
    }
    return false
  }
}

/**
 * Request the user's wallet to add a new chain.
 */
export async function addChain(
  provider: EthereumProvider,
  chainId: number
): Promise<boolean> {
  const config = EVM_CHAINS[chainId]
  if (!config) return false

  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [buildAddChainParams(config)],
    })
    return true
  } catch (_err) {
    /* non-critical: user rejected or wallet error */
    return false
  }
}

/**
 * Get the currently connected chain ID from the provider.
 */
export async function getCurrentChainId(
  provider: EthereumProvider
): Promise<number | null> {
  try {
    const result = await provider.request({ method: 'eth_chainId' })
    return Number(result as string)
  } catch (_err) {
    /* non-critical: wallet not connected */
    return null
  }
}

/**
 * Check whether the provider is connected to a supported chain.
 */
export async function isOnSupportedChain(
  provider: EthereumProvider
): Promise<boolean> {
  const chainId = await getCurrentChainId(provider)
  return chainId !== null && chainId in EVM_CHAINS
}

/**
 * Format an address for display: 0x1234...abcd
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (!address || address.length < 2 * chars + 2) return address
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

/**
 * Build a block explorer link for an address or transaction.
 */
export function getExplorerLink(
  chainId: number,
  hashOrAddress: string,
  type: 'address' | 'tx' = 'address'
): string | null {
  const config = EVM_CHAINS[chainId]
  if (!config) return null
  return `${config.explorerUrl}/${type}/${hashOrAddress}`
}
