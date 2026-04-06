/**
 * NFT Minting Utilities
 *
 * Server-side functions to mint Arena Pro membership NFTs.
 * Uses a dedicated minter wallet (private key from env) for transactions.
 */

import {
  createWalletClient,
  http,
  type Address,
  type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseChain, baseRpcUrl, CONTRACT_ADDRESSES, basePublicClient } from './contracts'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('NFTMint')

// ── ABI fragments for minting ──
const MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'renew',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'additionalDuration', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// Duration constants (in seconds)
export const MEMBERSHIP_DURATIONS = {
  monthly: 30 * 24 * 60 * 60, // 30 days
  yearly: 365 * 24 * 60 * 60, // 365 days
} as const

export type MintResult = {
  success: boolean
  txHash?: Hash
  tokenId?: bigint
  error?: string
}

/**
 * Get the minter wallet client.
 * Returns null if minter private key is not configured.
 */
function getMinterWalletClient() {
  const privateKey = process.env.NFT_MINTER_PRIVATE_KEY

  if (!privateKey) {
    return null
  }

  // Ensure proper format
  const formattedKey = privateKey.startsWith('0x')
    ? (privateKey as `0x${string}`)
    : (`0x${privateKey}` as `0x${string}`)

  const account = privateKeyToAccount(formattedKey)

  return createWalletClient({
    account,
    chain: baseChain,
    transport: http(baseRpcUrl),
  })
}

/**
 * Mint a new membership NFT to a wallet address.
 *
 * @param toAddress - The recipient wallet address
 * @param plan - The subscription plan ('monthly' or 'yearly')
 * @returns MintResult with success status and transaction details
 */
export async function mintMembershipNFT(
  toAddress: string,
  plan: 'monthly' | 'yearly'
): Promise<MintResult> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT

  if (!contractAddress) {
    logger.error('[Mint] Contract address not configured')
    return {
      success: false,
      error: 'NFT contract not deployed',
    }
  }

  const walletClient = getMinterWalletClient()

  if (!walletClient) {
    logger.error('[Mint] Minter private key not configured')
    return {
      success: false,
      error: 'Minter wallet not configured',
    }
  }

  const duration = BigInt(MEMBERSHIP_DURATIONS[plan])

  try {
    logger.info(`[Mint] Minting ${plan} NFT to ${toAddress}`)

    // Simulate the transaction first
    const { request } = await basePublicClient.simulateContract({
      address: contractAddress,
      abi: MINT_ABI,
      functionName: 'mint',
      args: [toAddress as Address, duration],
      account: walletClient.account,
    })

    // Execute the mint transaction
    const txHash = await walletClient.writeContract(request)

    logger.info(`[Mint] Transaction submitted: ${txHash}`)

    // Wait for transaction confirmation
    const receipt = await basePublicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    })

    if (receipt.status === 'reverted') {
      logger.error('[Mint] Transaction reverted')
      return {
        success: false,
        txHash,
        error: 'Transaction reverted',
      }
    }

    // Get the token ID from the event logs
    // The mint function emits a Transfer event with the tokenId
    const tokenId = extractTokenIdFromLogs(receipt.logs)

    logger.info(`[Mint] Success! TokenId: ${tokenId}, TxHash: ${txHash}`)

    return {
      success: true,
      txHash,
      tokenId,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error('[Mint] Failed:', errorMessage)

    return {
      success: false,
      error: errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage,
    }
  }
}

/**
 * Renew an existing membership NFT.
 *
 * @param tokenId - The token ID to renew
 * @param plan - The subscription plan for duration
 * @returns MintResult with success status
 */
export async function renewMembershipNFT(
  tokenId: bigint,
  plan: 'monthly' | 'yearly'
): Promise<MintResult> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT

  if (!contractAddress) {
    return { success: false, error: 'NFT contract not deployed' }
  }

  const walletClient = getMinterWalletClient()

  if (!walletClient) {
    return { success: false, error: 'Minter wallet not configured' }
  }

  const duration = BigInt(MEMBERSHIP_DURATIONS[plan])

  try {
    logger.info(`[Renew] Renewing TokenId ${tokenId} for ${plan}`)

    const { request } = await basePublicClient.simulateContract({
      address: contractAddress,
      abi: MINT_ABI,
      functionName: 'renew',
      args: [tokenId, duration],
      account: walletClient.account,
    })

    const txHash = await walletClient.writeContract(request)

    const receipt = await basePublicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    })

    if (receipt.status === 'reverted') {
      return { success: false, txHash, error: 'Transaction reverted' }
    }

    logger.info(`[Renew] Success! TxHash: ${txHash}`)

    return { success: true, txHash, tokenId }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error('[Renew] Failed:', errorMessage)
    return { success: false, error: errorMessage.slice(0, 200) }
  }
}

/**
 * Get the user's existing token ID (if any).
 */
export async function getUserTokenId(walletAddress: string): Promise<bigint | null> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT
  if (!contractAddress) return null

  try {
    // Check balance first
    const balance = await basePublicClient.readContract({
      address: contractAddress,
      abi: MINT_ABI,
      functionName: 'balanceOf',
      args: [walletAddress as Address],
    })

    if (Number(balance) === 0) {
      return null
    }

    // Get the first token
    const tokenId = await basePublicClient.readContract({
      address: contractAddress,
      abi: MINT_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [walletAddress as Address, 0n],
    })

    return tokenId
  } catch (_err) {
    // Intentionally swallowed: tokenOfOwnerByIndex call failed, wallet may not own any NFTs
    return null
  }
}

/**
 * Check if minting is properly configured.
 */
export function isMintingConfigured(): boolean {
  return !!(
    CONTRACT_ADDRESSES.membershipNFT &&
    process.env.NFT_MINTER_PRIVATE_KEY
  )
}

/**
 * Get minter wallet address (for debugging).
 */
export function getMinterAddress(): Address | null {
  const walletClient = getMinterWalletClient()
  return walletClient?.account?.address ?? null
}

// ── Helper functions ──

function extractTokenIdFromLogs(logs: readonly { topics: readonly string[]; data: string }[]): bigint | undefined {
  // ERC721 Transfer event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
  // Topic[0] is the event signature
  // Topic[3] (if indexed) is the tokenId

  for (const log of logs) {
    if (log.topics.length >= 4) {
      // The tokenId is in topic[3] for ERC721 Transfer
      try {
        return BigInt(log.topics[3])
      } catch (_err) {
        // Intentionally swallowed: BigInt parse of topic failed, try next log entry
        continue
      }
    }
  }

  return undefined
}
