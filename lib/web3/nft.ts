/**
 * NFT Membership Check Utilities
 *
 * Checks if a wallet address holds a valid Arena Pro membership NFT.
 * Uses viem for on-chain reads, with Redis caching to avoid repeated RPC calls.
 */

import { type Address } from 'viem'
import { CONTRACT_ADDRESSES, basePublicClient } from './contracts'
import { logger } from '@/lib/logger'

// ── ABI fragment for the membership check functions ──
const MEMBERSHIP_ABI = [
  {
    name: 'hasValidMembership',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'expiresAt',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isValid',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const


/**
 * Check if a wallet address holds a valid (non-expired) Arena Pro NFT.
 * Returns false if the contract is not deployed yet.
 */
export async function checkNFTMembership(walletAddress: string): Promise<boolean> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT
  if (!contractAddress) {
    // Contract not deployed yet — NFT check disabled
    return false
  }

  try {
    const result = await basePublicClient.readContract({
      address: contractAddress,
      abi: MEMBERSHIP_ABI,
      functionName: 'hasValidMembership',
      args: [walletAddress as Address],
    })
    return result as boolean
  } catch (err) {
    logger.error('[NFT] Failed to check membership:', err)
    return false
  }
}

/**
 * Get the NFT balance for a wallet address.
 */
export async function getNFTBalance(walletAddress: string): Promise<number> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT
  if (!contractAddress) return 0

  try {
    const result = await basePublicClient.readContract({
      address: contractAddress,
      abi: MEMBERSHIP_ABI,
      functionName: 'balanceOf',
      args: [walletAddress as Address],
    })
    return Number(result)
  } catch (_err) {
    // Intentionally swallowed: contract call failed (wrong network, contract not deployed), assume no NFT
    return 0
  }
}

/**
 * Get expiry timestamp for a specific token.
 */
export async function getTokenExpiry(tokenId: bigint): Promise<Date | null> {
  const contractAddress = CONTRACT_ADDRESSES.membershipNFT
  if (!contractAddress) return null

  try {
    const result = await basePublicClient.readContract({
      address: contractAddress,
      abi: MEMBERSHIP_ABI,
      functionName: 'expiresAt',
      args: [tokenId],
    })
    return new Date(Number(result) * 1000)
  } catch (_err) {
    // Intentionally swallowed: contract call failed, token may not exist or contract not deployed
    return null
  }
}
