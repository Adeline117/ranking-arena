/**
 * Canonical encryption boundary for `trader_authorizations` credentials.
 *
 * New writes use the colon-delimited AES-256-GCM format shared with
 * `user_exchange_connections`. Older authorization rows used the base64 GCM
 * format from `lib/crypto/encryption`; reads remain backward-compatible so a
 * deploy does not force every trader to reconnect their exchange account.
 */

import { decrypt as decryptCanonical, encrypt as encryptCanonical } from './encryption'
import { decrypt as decryptLegacy } from '@/lib/crypto/encryption'

const CANONICAL_CIPHERTEXT = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/i

export function encryptAuthorizationCredential(plaintext: string): string {
  return encryptCanonical(plaintext)
}

export function decryptAuthorizationCredential(ciphertext: string): string {
  if (CANONICAL_CIPHERTEXT.test(ciphertext)) {
    return decryptCanonical(ciphertext)
  }
  return decryptLegacy(ciphertext)
}
