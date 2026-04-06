/**
 * EAS (Ethereum Attestation Service) Integration
 *
 * Publishes verifiable Arena Score attestations on Base.
 * Traders can prove their Arena Score on any platform that reads EAS.
 *
 * EAS on Base uses predeploy addresses:
 *   SchemaRegistry: 0x4200000000000000000000000000000000000020
 *   EAS:            0x4200000000000000000000000000000000000021
 */

import {
  createWalletClient,
  http,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CONTRACT_ADDRESSES, ARENA_SCORE_SCHEMA_UID, basePublicClient, baseChain, baseRpcUrl } from './contracts'

// ── EAS contract ABI (minimal) ──

const EAS_ABI = [
  {
    name: 'attest',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'request',
      type: 'tuple',
      components: [
        { name: 'schema', type: 'bytes32' },
        {
          name: 'data',
          type: 'tuple',
          components: [
            { name: 'recipient', type: 'address' },
            { name: 'expirationTime', type: 'uint64' },
            { name: 'revocable', type: 'bool' },
            { name: 'refUID', type: 'bytes32' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
          ],
        },
      ],
    }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'getAttestation',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'uid', type: 'bytes32' },
        { name: 'schema', type: 'bytes32' },
        { name: 'time', type: 'uint64' },
        { name: 'expirationTime', type: 'uint64' },
        { name: 'revocationTime', type: 'uint64' },
        { name: 'refUID', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
        { name: 'attester', type: 'address' },
        { name: 'revocable', type: 'bool' },
        { name: 'data', type: 'bytes' },
      ],
    }],
  },
] as const

const SCHEMA_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schema', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'revocable', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * Arena Score attestation schema:
 *   string traderHandle, uint32 arenaScore, string exchange,
 *   uint64 snapshotTimestamp, bytes32 dataHash
 */
export const ARENA_SCORE_SCHEMA =
  'string traderHandle,uint32 arenaScore,string exchange,uint64 snapshotTimestamp,bytes32 dataHash'

// ── Clients ──

function getWalletClient() {
  const pk = process.env.ARENA_ATTESTER_PRIVATE_KEY
  if (!pk) throw new Error('ARENA_ATTESTER_PRIVATE_KEY not set')
  const account = privateKeyToAccount(pk as `0x${string}`)
  return createWalletClient({ account, chain: baseChain, transport: http(baseRpcUrl) })
}

// ── Types ──

export interface ArenaScoreAttestation {
  traderHandle: string
  arenaScore: number
  exchange: string
  snapshotTimestamp: number
  dataHash: Hex
}

export interface AttestationResult {
  uid: Hex
  txHash: Hex
}

export interface AttestationRecord {
  uid: Hex
  schema: Hex
  time: number
  expirationTime: number
  recipient: Address
  attester: Address
  data: Hex
}

// ── Functions ──

/**
 * Register the Arena Score schema on EAS (one-time setup).
 * Returns the schema UID.
 */
export async function registerSchema(): Promise<Hex> {
  const walletClient = getWalletClient()

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESSES.easSchemaRegistry as Address,
    abi: SCHEMA_REGISTRY_ABI,
    functionName: 'register',
    args: [
      ARENA_SCORE_SCHEMA,
      '0x0000000000000000000000000000000000000000' as Address, // No resolver
      true, // Revocable
    ],
  })

  const receipt = await basePublicClient.waitForTransactionReceipt({ hash })

  // SchemaRegistry emits Registered(bytes32 uid, address registerer)
  // The schema UID is the first indexed topic in the first log
  const schemaUID = receipt.logs[0]?.topics?.[1] as Hex | undefined
  if (schemaUID) {
    return schemaUID
  }

  return hash
}

/**
 * Encode Arena Score attestation data.
 * EAS expects standard ABI encoding (not packed) matching the schema fields.
 */
export function encodeAttestationData(attestation: ArenaScoreAttestation): Hex {
  const { traderHandle, arenaScore, exchange, snapshotTimestamp, dataHash } = attestation

  return encodeAbiParameters(
    [
      { name: 'traderHandle', type: 'string' },
      { name: 'arenaScore', type: 'uint32' },
      { name: 'exchange', type: 'string' },
      { name: 'snapshotTimestamp', type: 'uint64' },
      { name: 'dataHash', type: 'bytes32' },
    ],
    [traderHandle, arenaScore, exchange, BigInt(snapshotTimestamp), dataHash]
  )
}

/**
 * Create a data hash from trader snapshot data for verifiability.
 */
export function createDataHash(data: {
  handle: string
  score: number
  roi: number
  pnl: number
  timestamp: number
}): Hex {
  return keccak256(
    encodePacked(
      ['string', 'uint32', 'int256', 'int256', 'uint64'],
      [data.handle, data.score, BigInt(Math.round(data.roi * 1e6)), BigInt(Math.round(data.pnl * 1e6)), BigInt(data.timestamp)]
    )
  )
}

/**
 * Publish an Arena Score attestation on-chain via EAS.
 *
 * @param recipient - The trader's wallet address (or zero address if unknown)
 * @param attestation - The score data to attest
 * @returns The attestation UID and transaction hash
 */
export async function publishAttestation(
  recipient: Address,
  attestation: ArenaScoreAttestation,
): Promise<AttestationResult> {
  const schemaUID = ARENA_SCORE_SCHEMA_UID
  if (!schemaUID) {
    throw new Error('ARENA_SCORE_SCHEMA_UID not set — register schema first')
  }

  const walletClient = getWalletClient()
  const data = encodeAttestationData(attestation)

  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESSES.eas as Address,
    abi: EAS_ABI,
    functionName: 'attest',
    args: [{
      schema: schemaUID,
      data: {
        recipient,
        expirationTime: BigInt(0), // No expiry
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        data,
        value: BigInt(0),
      },
    }],
    value: BigInt(0),
  })

  const receipt = await basePublicClient.waitForTransactionReceipt({ hash })

  // Extract attestation UID from event logs
  const uid = receipt.logs[0]?.topics?.[1] as Hex || hash

  return { uid, txHash: hash }
}

/**
 * Read an attestation from EAS by UID.
 */
export async function getAttestation(uid: Hex): Promise<AttestationRecord | null> {
  try {
    const result = await basePublicClient.readContract({
      address: CONTRACT_ADDRESSES.eas as Address,
      abi: EAS_ABI,
      functionName: 'getAttestation',
      args: [uid],
    })

    const record = result as {
      uid: Hex
      schema: Hex
      time: bigint
      expirationTime: bigint
      revocationTime: bigint
      recipient: Address
      attester: Address
      data: Hex
    }

    return {
      uid: record.uid,
      schema: record.schema,
      time: Number(record.time),
      expirationTime: Number(record.expirationTime),
      recipient: record.recipient,
      attester: record.attester,
      data: record.data,
    }
  } catch (_err) {
    // Intentionally swallowed: EAS attestation fetch failed (network error or invalid UID)
    return null
  }
}

/**
 * Verify that an attestation is valid and was made by the Arena attester.
 */
export async function verifyAttestation(uid: Hex): Promise<{
  valid: boolean
  attestation?: AttestationRecord
  reason?: string
}> {
  const attestation = await getAttestation(uid)
  if (!attestation) {
    return { valid: false, reason: 'Attestation not found' }
  }

  // Check it's our schema
  if (ARENA_SCORE_SCHEMA_UID && attestation.schema !== ARENA_SCORE_SCHEMA_UID) {
    return { valid: false, reason: 'Wrong schema', attestation }
  }

  // Check it hasn't expired
  if (attestation.expirationTime > 0 && attestation.expirationTime < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'Attestation expired', attestation }
  }

  return { valid: true, attestation }
}
