/**
 * Contract Deployment Script
 *
 * Deploys ArenaMembership NFT contract to Base Sepolia testnet.
 *
 * Prerequisites:
 * 1. Set DEPLOYER_PRIVATE_KEY in .env (testnet wallet with Base Sepolia ETH)
 * 2. Get testnet ETH from https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
 *
 * Usage:
 *   npx tsx contracts/scripts/deploy.ts
 */

import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import * as fs from 'fs'
import * as path from 'path'

// Load environment variables
import 'dotenv/config'

// Contract bytecode will be compiled separately
// For now, we'll use a placeholder - in production, use solc or foundry

const _ARENA_MEMBERSHIP_ABI = [
  'constructor(address initialOwner, uint256 _defaultDuration)',
  'function mint(address to, uint256 duration) external returns (uint256)',
  'function renew(uint256 tokenId, uint256 additionalTime) external',
  'function revoke(uint256 tokenId) external',
  'function hasValidMembership(address user) external view returns (bool)',
  'function isValid(uint256 tokenId) external view returns (bool)',
  'function expiresAt(uint256 tokenId) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function setMintPrice(uint256 price) external',
  'function setDefaultDuration(uint256 duration) external',
  'function withdraw() external',
] as const

interface DeploymentResult {
  contractAddress: string
  transactionHash: string
  chainId: number
  chainName: string
  deployedAt: string
  deployer: string
}

async function deploy(): Promise<void> {
  console.warn('╔═══════════════════════════════════════════════════════════╗')
  console.warn('║         Arena Membership NFT Deployment                   ║')
  console.warn('╚═══════════════════════════════════════════════════════════╝')
  console.warn('')

  // Check for private key
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY
  if (!privateKey) {
    console.error('❌ Error: DEPLOYER_PRIVATE_KEY not set in environment')
    console.warn('')
    console.warn('To deploy:')
    console.warn('1. Create a new wallet for testnet deployment')
    console.warn('2. Get Base Sepolia ETH from: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet')
    console.warn('3. Add to .env: DEPLOYER_PRIVATE_KEY=0x...')
    process.exit(1)
  }

  // Create account from private key
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  console.warn(`📍 Deployer: ${account.address}`)
  console.warn(`🔗 Chain: Base Sepolia (${baseSepolia.id})`)
  console.warn('')

  // Create clients
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'),
  })

  const _walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'),
  })

  // Check balance
  const balance = await publicClient.getBalance({ address: account.address })
  console.warn(`💰 Balance: ${(Number(balance) / 1e18).toFixed(4)} ETH`)

  if (balance === 0n) {
    console.error('❌ Error: Insufficient balance. Get testnet ETH first.')
    process.exit(1)
  }

  console.warn('')
  console.warn('⚠️  Contract deployment requires compiled bytecode.')
  console.warn('')
  console.warn('To compile and deploy:')
  console.warn('')
  console.warn('Option 1: Use Foundry (recommended)')
  console.warn('  1. Install Foundry: curl -L https://foundry.paradigm.xyz | bash')
  console.warn('  2. Run: foundryup')
  console.warn('  3. Compile: forge build')
  console.warn('  4. Deploy: forge create --rpc-url $BASE_SEPOLIA_RPC_URL \\')
  console.warn('       --private-key $DEPLOYER_PRIVATE_KEY \\')
  console.warn('       contracts/ArenaMembership.sol:ArenaMembership \\')
  console.warn('       --constructor-args $DEPLOYER_ADDRESS 2592000')
  console.warn('')
  console.warn('Option 2: Use Remix IDE')
  console.warn('  1. Go to https://remix.ethereum.org')
  console.warn('  2. Create new file, paste ArenaMembership.sol')
  console.warn('  3. Compile with Solidity 0.8.20')
  console.warn('  4. Deploy to Base Sepolia via MetaMask')
  console.warn('')
  console.warn('After deployment, update .env:')
  console.warn('  NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS=0x...')

  // Save deployment info template
  const deploymentTemplate: Partial<DeploymentResult> = {
    chainId: baseSepolia.id,
    chainName: 'Base Sepolia',
    deployer: account.address,
  }

  const templatePath = path.join(__dirname, '../deployments/base-sepolia.template.json')
  fs.mkdirSync(path.dirname(templatePath), { recursive: true })
  fs.writeFileSync(templatePath, JSON.stringify(deploymentTemplate, null, 2))
  console.warn('')
  console.warn(`📄 Deployment template saved to: ${templatePath}`)
}

deploy().catch(console.error)
