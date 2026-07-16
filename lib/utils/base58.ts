const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/

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
