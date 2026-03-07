/**
 * EAS Attestation Minting for Arena Score
 *
 * Uses the EAS SDK + viem to create on-chain attestations on Base.
 * Called from MintArenaScore component via Privy wallet.
 */

import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { BrowserProvider } from 'ethers'
import {
  EAS_CONTRACT_ADDRESS,
  ARENA_SCORE_SCHEMA,
  ARENA_SCORE_SCHEMA_UID,
  BASE_CHAIN_ID,
} from './config'

interface MintArenaScoreParams {
  /** Privy wallet provider (window.ethereum or embedded wallet) */
  walletProvider: unknown
  /** Trader's wallet address */
  traderAddress: string
  /** Arena Score (integer) */
  arenaScore: number
  /** Exchange source (e.g. 'binance_futures') */
  source: string
  /** Score period ('7D', '30D', '90D', 'overall') */
  period: string
}

interface MintResult {
  attestationUid: string
  txHash: string
}

/**
 * Mint an Arena Score attestation on Base via EAS
 */
export async function mintArenaScoreAttestation({
  walletProvider,
  traderAddress,
  arenaScore,
  source,
  period,
}: MintArenaScoreParams): Promise<MintResult> {
  if (!ARENA_SCORE_SCHEMA_UID) {
    throw new Error('EAS Schema UID not configured. Set NEXT_PUBLIC_EAS_SCHEMA_UID env var.')
  }

  // Connect to Base chain via Privy wallet
  const provider = new BrowserProvider(walletProvider as never)
  const signer = await provider.getSigner()

  // Verify we're on Base
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== BASE_CHAIN_ID) {
    throw new Error(`Please switch to Base network (chain ID ${BASE_CHAIN_ID})`)
  }

  // Initialize EAS
  const eas = new EAS(EAS_CONTRACT_ADDRESS)
  eas.connect(signer)

  // Encode the attestation data
  const schemaEncoder = new SchemaEncoder(ARENA_SCORE_SCHEMA)
  const encodedData = schemaEncoder.encodeData([
    { name: 'trader', value: traderAddress, type: 'address' },
    { name: 'arenaScore', value: BigInt(Math.round(arenaScore)), type: 'uint256' },
    { name: 'source', value: source, type: 'string' },
    { name: 'period', value: period, type: 'string' },
    { name: 'timestamp', value: BigInt(Math.floor(Date.now() / 1000)), type: 'uint64' },
  ])

  // Create the attestation (on-chain, non-revocable)
  const tx = await eas.attest({
    schema: ARENA_SCORE_SCHEMA_UID,
    data: {
      recipient: traderAddress,
      expirationTime: BigInt(0), // No expiration
      revocable: false,
      data: encodedData,
    },
  })

  const attestationUid = await tx.wait()

  return {
    attestationUid,
    txHash: tx.receipt?.hash || '',
  }
}
