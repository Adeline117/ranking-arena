/**
 * On-Chain Contract Detector
 *
 * Uses eth_getCode (via viem getBytecode) to determine if a 0x address
 * is a smart contract or an EOA. This is a ground-truth signal:
 *   - bytecode present → contract → definitively a bot/vault
 *   - no bytecode → EOA → controlled by a private key (human or script)
 *
 * Results are cached in trader_sources.is_contract (immutable per address+chain).
 */

import { createPublicClient, http, type PublicClient, type Address, type Chain } from 'viem'
import { arbitrum, optimism, polygon, mainnet, bsc } from 'viem/chains'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('contract-detector')

// ── Chain configs ──

const CHAIN_CONFIGS: Record<number, { chain: Chain; rpc: string }> = {
  42161: { chain: arbitrum, rpc: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc' },
  10: { chain: optimism, rpc: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io' },
  137: { chain: polygon, rpc: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com' },
  1: { chain: mainnet, rpc: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com' },
  56: { chain: bsc, rpc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org' },
}

/**
 * DEX platform → EVM chain ID to check.
 * Only EVM-compatible DEXes with 0x addresses are listed.
 * dYdX (Cosmos) and Drift/Jupiter (Solana) are excluded — their addresses
 * don't start with 0x so they're filtered out before reaching this map.
 */
export const DEX_CHAIN_MAP: Record<string, number> = {
  hyperliquid: 42161, // Users bridge from Arbitrum
  gmx: 42161, // Native on Arbitrum
  gains: 42161, // Primary on Arbitrum
  aevo: 10, // OP Stack L2
  okx_web3: 1, // Ethereum mainnet
  binance_web3: 56, // BNB Chain
  copin: 42161, // Aggregator, mostly Arb/OP traders
}

// ── Client cache ──

const clients = new Map<number, PublicClient>()

function getClient(chainId: number): PublicClient {
  const existing = clients.get(chainId)
  if (existing) return existing

  const config = CHAIN_CONFIGS[chainId]
  if (!config) throw new Error(`Unsupported chain for contract detection: ${chainId}`)

  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpc),
  })

  clients.set(chainId, client)
  return client
}

// ── Public API ──

/**
 * Returns the chain ID to use for contract detection, or null if the
 * platform doesn't support on-chain checks.
 */
export function getChainForPlatform(platform: string): number | null {
  return DEX_CHAIN_MAP[platform] ?? null
}

/**
 * Check if a single address is a smart contract.
 * Returns true (contract), false (EOA), or null (RPC error — don't cache).
 */
export async function isContract(address: string, chainId: number): Promise<boolean | null> {
  try {
    const client = getClient(chainId)
    const bytecode = await client.getBytecode({ address: address as Address })
    // getBytecode returns undefined for EOAs, hex string for contracts
    return bytecode != null && bytecode !== '0x' && bytecode.length > 2
  } catch (err) {
    log.warn(`RPC error checking ${address} on chain ${chainId}`, err)
    return null
  }
}

/**
 * Batch check multiple addresses on a single chain.
 * Uses controlled concurrency to respect RPC rate limits.
 */
export async function batchCheckContracts(
  addresses: string[],
  chainId: number,
  concurrency = 20
): Promise<Map<string, boolean | null>> {
  const results = new Map<string, boolean | null>()
  if (addresses.length === 0) return results

  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      batch.map(async (addr) => ({
        addr,
        result: await isContract(addr, chainId),
      }))
    )

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.addr, outcome.value.result)
      }
      // Rejected promises are silently skipped (already logged in isContract)
    }

    // 200ms pause between batches to avoid hammering free RPCs
    if (i + concurrency < addresses.length) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  return results
}
