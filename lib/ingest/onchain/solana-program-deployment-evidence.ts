import { createHash } from 'node:crypto'

import { decodeBase58BytesBounded, hasBase58DecodedByteLength } from '@/lib/utils/base58'

import { exactDataRecord, exactDenseArray } from './solana-evidence-core'

export const SOLANA_BPF_LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111' as const
export const SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES = 36 as const
export const SOLANA_V3_PROGRAMDATA_HEADER_BYTES = 45 as const
export const SOLANA_V3_DEPLOYMENT_EFFECTIVE_SLOT_OFFSET = 1n
export const SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES = 10 * 1024 * 1024
export const SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY =
  'single_rpc_decoded_current_v3_program_and_programdata_account_state_only_not_raw_capture_provenance_provider_independence_cryptographic_finality_historical_code_epochs_source_or_build_identity_protocol_ownership_invocation_decoder_facts_wallet_attribution_metrics_or_legal_clearance' as const

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const U64_MAX = (1n << 64n) - 1n
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length'
)?.get
const INVALID_PREFIX = 'invalid Solana v3 program deployment observation:'
const ED25519_PRIME = (1n << 255n) - 19n
const ED25519_D = mod(-121665n * modPow(121666n, ED25519_PRIME - 2n))
const ED25519_SQRT_M1 = modPow(2n, (ED25519_PRIME - 1n) / 4n)

interface ParsedProgramAccount {
  dataBase64: string
  executable: boolean
  owner: string
  space: number
}

export interface SolanaV3ProgramDeploymentObservationInput {
  program_id: string
  programdata_address: string
  requested_min_context_slot: number
  result: unknown
}

export interface SolanaV3ProgramDeploymentObservation {
  chain: 'solana'
  semantic_state: 'v3_program_and_programdata_accounts_consistent'
  proof_boundary: typeof SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY
  loader_program_id: typeof SOLANA_BPF_LOADER_V3
  program_id: string
  programdata_address: string
  programdata_bump_seed: number
  requested_min_context_slot_decimal: string
  accounts_context_slot_decimal: string
  program_account: {
    owner: typeof SOLANA_BPF_LOADER_V3
    executable: true
    space: typeof SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES
    data_sha256: string
    programdata_address: string
  }
  programdata_account: {
    owner: typeof SOLANA_BPF_LOADER_V3
    executable: false
    space: number
    data_sha256: string
    last_modified_slot_decimal: string
    effective_slot_decimal: string
    upgrade_authority: { state: 'present'; address: string } | { state: 'revoked'; address: null }
    code_offset_bytes: typeof SOLANA_V3_PROGRAMDATA_HEADER_BYTES
    code_byte_length: number
    code_sha256: string
    code_hash_basis: 'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros'
  }
}

function invalid(reason: string): never {
  throw new TypeError(`${INVALID_PREFIX} ${reason}`)
}

function safePositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    Object.is(value, -0)
  ) {
    invalid(`${label} must be a positive safe integer`)
  }
  return value
}

function publicKey(value: unknown, label: string): string {
  if (!hasBase58DecodedByteLength(value, 32)) {
    invalid(`${label} must be a base58-encoded 32-byte public key`)
  }
  return value
}

function parseInput(input: unknown): SolanaV3ProgramDeploymentObservationInput {
  const record = exactDataRecord(input, [
    'program_id',
    'programdata_address',
    'requested_min_context_slot',
    'result',
  ])
  if (!record) invalid('input has an unexpected shape')
  return {
    program_id: publicKey(record.program_id, 'program_id'),
    programdata_address: publicKey(record.programdata_address, 'programdata_address'),
    requested_min_context_slot: safePositiveInteger(
      record.requested_min_context_slot,
      'requested_min_context_slot'
    ),
    result: record.result,
  }
}

function parseContext(value: unknown): number {
  const withVersion = exactDataRecord(value, ['apiVersion', 'slot'])
  if (withVersion) {
    if (
      typeof withVersion.apiVersion !== 'string' ||
      withVersion.apiVersion.length === 0 ||
      withVersion.apiVersion.length > 64 ||
      withVersion.apiVersion.trim() !== withVersion.apiVersion
    ) {
      invalid('context apiVersion is malformed')
    }
    return safePositiveInteger(withVersion.slot, 'accounts context slot')
  }
  const withoutVersion = exactDataRecord(value, ['slot'])
  if (!withoutVersion) invalid('result context has an unexpected shape')
  return safePositiveInteger(withoutVersion.slot, 'accounts context slot')
}

function finiteNonnegativeInteger(value: unknown, label: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    invalid(`${label} must be a nonnegative JSON integer`)
  }
}

function isBase64AlphabetCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  )
}

function isCanonicalBase64Text(value: string, decodedByteLength: number): boolean {
  const expectedLength = 4 * Math.ceil(decodedByteLength / 3)
  if (value.length !== expectedLength || expectedLength === 0) return false
  const remainder = decodedByteLength % 3
  const paddingLength = remainder === 0 ? 0 : 3 - remainder
  const dataLength = value.length - paddingLength
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64AlphabetCode(value.charCodeAt(index))) return false
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false
  }
  return true
}

function parseAccount(value: unknown, label: string, expectedSpace?: number): ParsedProgramAccount {
  const account = exactDataRecord(value, [
    'data',
    'executable',
    'lamports',
    'owner',
    'rentEpoch',
    'space',
  ])
  if (!account) invalid(`${label} has an unexpected shape`)
  const space = safePositiveInteger(account.space, `${label} space`)
  if (space > SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES) {
    invalid(`${label} space exceeds the Solana account data byte bound`)
  }
  if (expectedSpace !== undefined && space !== expectedSpace) {
    invalid(`${label} space conflicts with its fixed state size`)
  }
  const data = exactDenseArray(account.data)
  if (
    !data ||
    data.length !== 2 ||
    typeof data[0] !== 'string' ||
    data[1] !== 'base64' ||
    !isCanonicalBase64Text(data[0], space)
  ) {
    invalid(`${label} data must be canonical bounded base64`)
  }
  if (typeof account.executable !== 'boolean') invalid(`${label} executable must be boolean`)
  finiteNonnegativeInteger(account.lamports, `${label} lamports`)
  finiteNonnegativeInteger(account.rentEpoch, `${label} rentEpoch`)
  return {
    dataBase64: data[0],
    executable: account.executable,
    owner: publicKey(account.owner, `${label} owner`),
    space,
  }
}

function decodeCanonicalBase64(value: string, expectedBytes: number, label: string): Buffer {
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    invalid(`${label} data is not decodable base64`)
  }
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString('base64') !== value ||
    decoded.byteLength === 0
  ) {
    clearDecodedBytes(decoded)
    invalid(`${label} data conflicts with its canonical base64 or space`)
  }
  return decoded
}

function clearDecodedBytes(bytes: Uint8Array): void {
  try {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0])
    if (!TYPED_ARRAY_LENGTH_GETTER) throw new TypeError('TypedArray length unavailable')
    const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
    if (!Number.isSafeInteger(length) || Number(length) < 0) {
      throw new TypeError('invalid decoded byte length')
    }
    for (let index = 0; index < Number(length); index += 1) {
      if (bytes[index] !== 0) throw new TypeError('decoded bytes were not cleared')
    }
  } catch {
    throw new TypeError('Solana program account decoded bytes could not be cleared')
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1
  let numeric = 0n
  for (const byte of bytes) numeric = (numeric << 8n) + BigInt(byte)
  let encoded = ''
  while (numeric > 0n) {
    encoded = BASE58_ALPHABET[Number(numeric % 58n)] + encoded
    numeric /= 58n
  }
  return '1'.repeat(leadingZeroes) + encoded
}

function readPublicKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) invalid('decoded public key has the wrong byte length')
  return encodeBase58(bytes)
}

function mod(value: bigint): bigint {
  const result = value % ED25519_PRIME
  return result < 0n ? result + ED25519_PRIME : result
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let factor = mod(base)
  for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
    if ((remaining & 1n) === 1n) result = mod(result * factor)
    factor = mod(factor * factor)
  }
  return result
}

function isEd25519CurvePoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false
  const encoded = Uint8Array.from(bytes)
  const xSign = (encoded[31] & 0x80) !== 0
  encoded[31] &= 0x7f
  let y = 0n
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    y = (y << 8n) + BigInt(encoded[index])
  }
  if (y >= ED25519_PRIME) return false

  const ySquared = mod(y * y)
  const xSquared = mod((ySquared - 1n) * modPow(mod(ED25519_D * ySquared + 1n), ED25519_PRIME - 2n))
  let x = modPow(xSquared, (ED25519_PRIME + 3n) / 8n)
  if (mod(x * x) !== xSquared) x = mod(x * ED25519_SQRT_M1)
  if (mod(x * x) !== xSquared) return false
  return !(x === 0n && xSign)
}

function programDataAddressCandidate(programId: string, bumpSeed: number): string | null {
  const program = decodeBase58BytesBounded(programId, 32)
  const loader = decodeBase58BytesBounded(SOLANA_BPF_LOADER_V3, 32)
  if (
    program?.byteLength !== 32 ||
    loader?.byteLength !== 32 ||
    !Number.isInteger(bumpSeed) ||
    bumpSeed < 0 ||
    bumpSeed > 255
  ) {
    invalid('cannot derive ProgramData from invalid public keys')
  }
  const digest = createHash('sha256')
    .update(program)
    .update(Uint8Array.of(bumpSeed))
    .update(loader)
    .update('ProgramDerivedAddress', 'utf8')
    .digest()
  return isEd25519CurvePoint(digest) ? null : encodeBase58(digest)
}

export function findSolanaV3ProgramDataAddress(programId: string): {
  address: string
  bump_seed: number
} {
  const canonicalProgramId = publicKey(programId, 'program_id')
  for (let bumpSeed = 255; bumpSeed >= 0; bumpSeed -= 1) {
    const address = programDataAddressCandidate(canonicalProgramId, bumpSeed)
    if (address !== null) return { address, bump_seed: bumpSeed }
  }
  invalid('unable to derive an off-curve loader-v3 ProgramData address')
}

function parseProgramAccount(
  account: ParsedProgramAccount,
  expectedProgramDataAddress: string
): SolanaV3ProgramDeploymentObservation['program_account'] {
  if (account.owner !== SOLANA_BPF_LOADER_V3) invalid('Program account owner is not loader v3')
  if (!account.executable) invalid('Program account must be executable')
  if (account.space !== SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES) {
    invalid('Program account must contain exactly 36 state bytes')
  }
  const bytes = decodeCanonicalBase64(account.dataBase64, account.space, 'Program account')
  try {
    if (bytes.readUInt32LE(0) !== 2) invalid('Program account state tag is not Program')
    const programDataAddress = readPublicKey(bytes.subarray(4, 36))
    if (programDataAddress !== expectedProgramDataAddress) {
      invalid('Program account pointer does not match the derived ProgramData address')
    }
    return {
      owner: SOLANA_BPF_LOADER_V3,
      executable: true,
      space: SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
      data_sha256: sha256(bytes),
      programdata_address: programDataAddress,
    }
  } finally {
    clearDecodedBytes(bytes)
  }
}

function parseProgramDataAccount(
  account: ParsedProgramAccount,
  contextSlot: number
): SolanaV3ProgramDeploymentObservation['programdata_account'] {
  if (account.owner !== SOLANA_BPF_LOADER_V3) invalid('ProgramData owner is not loader v3')
  if (account.executable) invalid('ProgramData account must not be executable')
  if (account.space <= SOLANA_V3_PROGRAMDATA_HEADER_BYTES) {
    invalid('ProgramData account must contain code after the 45-byte state header')
  }
  const bytes = decodeCanonicalBase64(account.dataBase64, account.space, 'ProgramData account')
  try {
    if (bytes.readUInt32LE(0) !== 3) invalid('ProgramData state tag is not ProgramData')
    const lastModifiedSlot = bytes.readBigUInt64LE(4)
    if (lastModifiedSlot === 0n) invalid('ProgramData last-modified slot must be positive')
    if (lastModifiedSlot === U64_MAX) invalid('ProgramData effective slot would overflow u64')
    const effectiveSlot = lastModifiedSlot + SOLANA_V3_DEPLOYMENT_EFFECTIVE_SLOT_OFFSET
    if (BigInt(contextSlot) < effectiveSlot) {
      invalid('accounts context predates the ProgramData effective slot')
    }

    const authorityOption = bytes[12]
    let upgradeAuthority: SolanaV3ProgramDeploymentObservation['programdata_account']['upgrade_authority']
    if (authorityOption === 0) {
      upgradeAuthority = { state: 'revoked', address: null }
    } else if (authorityOption === 1) {
      const address = readPublicKey(bytes.subarray(13, 45))
      if (address === DEFAULT_PUBLIC_KEY) invalid('upgrade authority cannot be the default key')
      upgradeAuthority = { state: 'present', address }
    } else {
      invalid('ProgramData upgrade-authority option tag is invalid')
    }

    const code = bytes.subarray(SOLANA_V3_PROGRAMDATA_HEADER_BYTES)
    return {
      owner: SOLANA_BPF_LOADER_V3,
      executable: false,
      space: account.space,
      data_sha256: sha256(bytes),
      last_modified_slot_decimal: lastModifiedSlot.toString(),
      effective_slot_decimal: effectiveSlot.toString(),
      upgrade_authority: upgradeAuthority,
      code_offset_bytes: SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
      code_byte_length: code.byteLength,
      code_sha256: sha256(code),
      code_hash_basis:
        'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros',
    }
  } finally {
    clearDecodedBytes(bytes)
  }
}

function parseObservation(input: unknown): SolanaV3ProgramDeploymentObservation {
  const parsedInput = parseInput(input)
  const derivedProgramData = findSolanaV3ProgramDataAddress(parsedInput.program_id)
  if (parsedInput.programdata_address !== derivedProgramData.address) {
    invalid('programdata_address is not the canonical loader-v3 PDA')
  }

  const result = exactDataRecord(parsedInput.result, ['context', 'value'])
  if (!result) invalid('getMultipleAccounts result has an unexpected shape')
  const contextSlot = parseContext(result.context)
  if (contextSlot < parsedInput.requested_min_context_slot) {
    invalid('accounts context predates the requested minimum context slot')
  }
  const accounts = exactDenseArray(result.value)
  if (!accounts || accounts.length !== 2 || accounts[0] === null || accounts[1] === null) {
    invalid('getMultipleAccounts must return Program and ProgramData in request order')
  }

  const programAccount = parseProgramAccount(
    parseAccount(accounts[0], 'Program account', SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES),
    parsedInput.programdata_address
  )
  const programDataAccount = parseProgramDataAccount(
    parseAccount(accounts[1], 'ProgramData account'),
    contextSlot
  )

  return {
    chain: 'solana',
    semantic_state: 'v3_program_and_programdata_accounts_consistent',
    proof_boundary: SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
    loader_program_id: SOLANA_BPF_LOADER_V3,
    program_id: parsedInput.program_id,
    programdata_address: parsedInput.programdata_address,
    programdata_bump_seed: derivedProgramData.bump_seed,
    requested_min_context_slot_decimal: String(parsedInput.requested_min_context_slot),
    accounts_context_slot_decimal: String(contextSlot),
    program_account: programAccount,
    programdata_account: programDataAccount,
  }
}

export function parseSolanaV3ProgramDeploymentObservation(
  input: unknown
): SolanaV3ProgramDeploymentObservation {
  try {
    return parseObservation(input)
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(INVALID_PREFIX)) throw error
    throw new TypeError(`${INVALID_PREFIX} input could not be inspected safely`)
  }
}
