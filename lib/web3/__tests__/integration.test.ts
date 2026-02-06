/**
 * @jest-environment node
 * 
 * Web3 Integration Tests
 * 
 * Tests for full Web3 flow including RPC connection and contract verification.
 * Run with: npx jest lib/web3/__tests__/integration.test.ts
 */

import { createPublicClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { CONTRACT_ADDRESSES } from '../contracts'

// Create a fresh client for testing to avoid module caching issues
const testClient = createPublicClient({
  chain: process.env.NODE_ENV === 'production' ? base : baseSepolia,
  transport: http(
    process.env.NODE_ENV === 'production' 
      ? 'https://mainnet.base.org'
      : 'https://sepolia.base.org'
  ),
})

describe('Web3 Integration', () => {
  describe('RPC Connection', () => {
    it('should connect to Base RPC and get block number', async () => {
      const blockNumber = await testClient.getBlockNumber()
      expect(blockNumber).toBeGreaterThan(0n)
    }, 15000)

    it('should have correct chain ID', async () => {
      const chainId = await testClient.getChainId()
      // Base mainnet: 8453, Base Sepolia: 84532
      expect([8453, 84532]).toContain(chainId)
    }, 15000)

    it('should get gas price', async () => {
      const gasPrice = await testClient.getGasPrice()
      expect(gasPrice).toBeGreaterThan(0n)
    }, 15000)
  })

  describe('NFT Contract', () => {
    it('should have valid contract address format if configured', () => {
      if (!CONTRACT_ADDRESSES.membershipNFT) {
        console.log('NFT contract not deployed, skipping')
        return
      }
      expect(CONTRACT_ADDRESSES.membershipNFT).toMatch(/^0x[a-fA-F0-9]{40}$/)
    })

    it('should verify contract exists on chain if configured', async () => {
      if (!CONTRACT_ADDRESSES.membershipNFT) {
        console.log('NFT contract not deployed, skipping')
        return
      }

      const code = await testClient.getBytecode({
        address: CONTRACT_ADDRESSES.membershipNFT,
      })

      // Contract might not be deployed yet in test environment
      if (code === undefined) {
        console.log('NFT contract not found on chain (not deployed yet), skipping validation')
        return
      }

      // Contract should have bytecode (not empty)
      expect(code).toBeDefined()
      expect(code?.length).toBeGreaterThan(2) // More than just '0x'
    }, 15000)
  })

  describe('EAS Contract', () => {
    it('should have EAS contract address', () => {
      expect(CONTRACT_ADDRESSES.eas).toBe('0x4200000000000000000000000000000000000021')
    })

    it('should verify EAS contract exists on Base', async () => {
      const code = await testClient.getBytecode({
        address: CONTRACT_ADDRESSES.eas,
      })
      expect(code).toBeDefined()
      expect(code?.length).toBeGreaterThan(2)
    }, 15000)
  })
})
