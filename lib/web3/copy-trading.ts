/**
 * Copy Trading Contract Integration
 *
 * Types and utilities for interacting with on-chain copy trading contracts.
 * This provides the interface layer - actual contract deployment is separate.
 *
 * Key features:
 * - Subscribe to trader strategies
 * - Set allocation limits
 * - Emergency exit positions
 */

import { type Address, type Hex } from 'viem'

// ── Types ──

export type CopyTradeStatus = 'active' | 'paused' | 'stopped' | 'liquidated'

export interface CopyTradeStrategy {
  id: string
  traderAddress: Address
  traderHandle: string
  followerAddress: Address
  allocation: bigint // Amount allocated in base currency (e.g., USDC)
  maxPositionSize: bigint // Maximum per-position size
  stopLossPercent: number // Auto-stop loss threshold (0-100)
  takeProfitPercent?: number // Optional take profit threshold
  leverage: number // Maximum allowed leverage
  status: CopyTradeStatus
  totalPnl: bigint // Total realized PnL
  unrealizedPnl: bigint // Current unrealized PnL
  createdAt: number
  updatedAt: number
}

export interface CopyTradePosition {
  id: string
  strategyId: string
  symbol: string
  side: 'long' | 'short'
  size: bigint
  entryPrice: bigint
  currentPrice: bigint
  unrealizedPnl: bigint
  leverage: number
  openedAt: number
}

export interface CopyTradeSubscription {
  strategyId: string
  txHash: Hex
}

export interface CopyTradeConfig {
  minAllocation: bigint // Minimum subscription amount
  maxFollowers: number // Maximum followers per trader
  platformFeePercent: number // Platform fee (basis points)
  traderSharePercent: number // Trader's share of profits (basis points)
}

// ── Contract ABI (minimal) ──

export const COPY_TRADING_ABI = [
  // View functions
  {
    name: 'getStrategy',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'trader', type: 'address' },
        { name: 'follower', type: 'address' },
        { name: 'allocation', type: 'uint256' },
        { name: 'maxPositionSize', type: 'uint256' },
        { name: 'stopLossPercent', type: 'uint8' },
        { name: 'leverage', type: 'uint8' },
        { name: 'status', type: 'uint8' },
        { name: 'totalPnl', type: 'int256' },
      ],
    }],
  },
  {
    name: 'getPositions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple[]',
      components: [
        { name: 'symbol', type: 'bytes32' },
        { name: 'side', type: 'uint8' },
        { name: 'size', type: 'uint256' },
        { name: 'entryPrice', type: 'uint256' },
        { name: 'leverage', type: 'uint8' },
      ],
    }],
  },
  // Write functions
  {
    name: 'subscribe',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'trader', type: 'address' },
      { name: 'allocation', type: 'uint256' },
      { name: 'maxPositionSize', type: 'uint256' },
      { name: 'stopLossPercent', type: 'uint8' },
      { name: 'leverage', type: 'uint8' },
    ],
    outputs: [{ name: 'strategyId', type: 'bytes32' }],
  },
  {
    name: 'unsubscribe',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'pause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'resume',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'emergencyExit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'updateSettings',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'maxPositionSize', type: 'uint256' },
      { name: 'stopLossPercent', type: 'uint8' },
      { name: 'leverage', type: 'uint8' },
    ],
    outputs: [],
  },
] as const

// ── Contract Addresses (per chain) ──

export const COPY_TRADING_ADDRESSES: Record<number, Address | undefined> = {
  8453: undefined, // Base mainnet - not deployed
  84532: undefined, // Base Sepolia - not deployed
  42161: undefined, // Arbitrum - not deployed
  10: undefined, // Optimism - not deployed
}

// ── Utility Functions ──

/**
 * Check if copy trading is available on a given chain.
 */
export function isCopyTradingAvailable(chainId: number): boolean {
  return !!COPY_TRADING_ADDRESSES[chainId]
}

/**
 * Get the copy trading contract address for a chain.
 */
export function getCopyTradingAddress(chainId: number): Address | null {
  return COPY_TRADING_ADDRESSES[chainId] ?? null
}

/**
 * Calculate follower's PnL after fees.
 */
export function calculateNetPnl(
  grossPnl: bigint,
  platformFeeBps: number,
  traderShareBps: number
): bigint {
  if (grossPnl <= 0n) return grossPnl // No fees on losses

  const platformFee = (grossPnl * BigInt(platformFeeBps)) / 10000n
  const traderShare = (grossPnl * BigInt(traderShareBps)) / 10000n

  return grossPnl - platformFee - traderShare
}

/**
 * Format position for display.
 */
export function formatPosition(position: CopyTradePosition): {
  symbol: string
  side: string
  size: string
  entryPrice: string
  pnl: string
  pnlPercent: string
} {
  const pnlPercent = position.entryPrice > 0n
    ? Number((position.unrealizedPnl * 10000n) / position.entryPrice) / 100
    : 0

  return {
    symbol: position.symbol,
    side: position.side.toUpperCase(),
    size: (Number(position.size) / 1e6).toFixed(2), // Assuming 6 decimals
    entryPrice: (Number(position.entryPrice) / 1e6).toFixed(4),
    pnl: (Number(position.unrealizedPnl) / 1e6).toFixed(2),
    pnlPercent: `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
  }
}
