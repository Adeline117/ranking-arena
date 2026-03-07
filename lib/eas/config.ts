/**
 * EAS (Ethereum Attestation Service) Configuration for Base Chain
 *
 * Arena Score attestations are minted as on-chain SBTs via EAS on Base.
 * Schema: address trader, uint256 arenaScore, string source, string period, uint64 timestamp
 */

// Base Mainnet (chain ID 8453)
export const EAS_CONTRACT_ADDRESS = '0x4200000000000000000000000000000000000021'
export const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020'

// Arena Score schema - registered on Base via SchemaRegistry
// Schema UID is set after first registration (see registerSchema below)
// Format: "address trader, uint256 arenaScore, string source, string period, uint64 timestamp"
export const ARENA_SCORE_SCHEMA = 'address trader, uint256 arenaScore, string source, string period, uint64 timestamp'

// Set this after registering the schema on-chain
export const ARENA_SCORE_SCHEMA_UID = process.env.NEXT_PUBLIC_EAS_SCHEMA_UID || ''

export const BASE_CHAIN_ID = 8453

export const BASE_RPC_URL = 'https://mainnet.base.org'
