const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/
const MAX_BOUNDED_DECODE_BYTES = 4_096

export function isBase58String(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && BASE58_PATTERN.test(value)
}

/** Return the exact decoded byte length, or null when the input is not Base58. */
export function base58DecodedByteLength(value: string): number | null {
  if (typeof value !== 'string' || (value.length > 0 && !BASE58_PATTERN.test(value))) return null

  let numericValue = 0n
  for (const character of value) {
    numericValue = numericValue * 58n + BigInt(BASE58_ALPHABET.indexOf(character))
  }

  let significantBytes = 0
  for (let remaining = numericValue; remaining > 0n; remaining >>= 8n) significantBytes += 1

  let leadingZeroBytes = 0
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') {
    leadingZeroBytes += 1
  }
  return leadingZeroBytes + significantBytes
}

export function hasBase58DecodedByteLength(
  value: unknown,
  expectedByteLength: number
): value is string {
  if (
    typeof value !== 'string' ||
    !Number.isSafeInteger(expectedByteLength) ||
    expectedByteLength <= 0 ||
    value.length === 0 ||
    // A Base58 encoding of N bytes is always well below 2N characters. This
    // also bounds BigInt work before decoding untrusted identity strings.
    value.length > expectedByteLength * 2
  ) {
    return false
  }
  return base58DecodedByteLength(value) === expectedByteLength
}

/**
 * Decode a Base58 value only when its decoded size fits the caller's bound.
 *
 * The encoded-length check runs before BigInt conversion, so untrusted input
 * cannot turn a small expected payload into unbounded CPU or allocation work.
 * An empty string canonically represents an empty byte array.
 */
export function decodeBase58BytesBounded(
  value: unknown,
  maximumByteLength: number
): Uint8Array | null {
  if (
    !Number.isSafeInteger(maximumByteLength) ||
    maximumByteLength < 0 ||
    maximumByteLength > MAX_BOUNDED_DECODE_BYTES ||
    Object.is(maximumByteLength, -0)
  ) {
    throw new TypeError('maximumByteLength must be a bounded nonnegative safe integer')
  }
  if (
    typeof value !== 'string' ||
    value.length > maximumByteLength * 2 ||
    (value.length > 0 && !BASE58_PATTERN.test(value))
  ) {
    return null
  }

  let numericValue = 0n
  for (const character of value) {
    numericValue = numericValue * 58n + BigInt(BASE58_ALPHABET.indexOf(character))
  }

  let significantBytes = 0
  for (let remaining = numericValue; remaining > 0n; remaining >>= 8n) {
    significantBytes += 1
  }
  let leadingZeroBytes = 0
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') {
    leadingZeroBytes += 1
  }
  const decodedByteLength = leadingZeroBytes + significantBytes
  if (decodedByteLength > maximumByteLength) return null

  const decoded = new Uint8Array(decodedByteLength)
  for (let index = decodedByteLength - 1; index >= leadingZeroBytes; index -= 1) {
    decoded[index] = Number(numericValue & 0xffn)
    numericValue >>= 8n
  }
  return decoded
}
