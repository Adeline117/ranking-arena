/**
 * EAS Attestation Minting for Arena Score
 *
 * Uses the EAS SDK + ethers to create on-chain attestations on Base.
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
  walletProvider: unknown
  traderAddress: string
  arenaScore: number
  source: string
  period: string
}

interface MintResult {
  attestationUid: string
  txHash: string
}

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

  const provider = new BrowserProvider(walletProvider as never)
  const signer = await provider.getSigner()

  const network = await provider.getNetwork()
  if (Number(network.chainId) !== BASE_CHAIN_ID) {
    throw new Error(`Please switch to Base network (chain ID ${BASE_CHAIN_ID})`)
  }

  const eas = new EAS(EAS_CONTRACT_ADDRESS)
  eas.connect(signer)

  const schemaEncoder = new SchemaEncoder(ARENA_SCORE_SCHEMA)
  const encodedData = schemaEncoder.encodeData([
    { name: 'trader', value: traderAddress, type: 'address' },
    { name: 'arenaScore', value: BigInt(Math.round(arenaScore)), type: 'uint256' },
    { name: 'source', value: source, type: 'string' },
    { name: 'period', value: period, type: 'string' },
    { name: 'timestamp', value: BigInt(Math.floor(Date.now() / 1000)), type: 'uint64' },
  ])

  const tx = await eas.attest({
    schema: ARENA_SCORE_SCHEMA_UID,
    data: {
      recipient: traderAddress,
      expirationTime: BigInt(0),
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
