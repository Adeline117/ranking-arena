/**
 * TOTP (Time-based One-Time Password) Service
 *
 * Provides 2FA functionality including:
 * - TOTP secret generation
 * - Code verification
 * - Backup code generation and verification
 */

import * as OTPAuth from 'otpauth'
import { createHash, randomBytes } from 'crypto'

const APP_NAME = 'RankingArena'

export function generateTotpSecret(userEmail: string): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: APP_NAME,
    label: userEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  })
  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  }
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  })
  const delta = totp.validate({ token: code, window: 1 })
  return delta !== null
}

export function generateBackupCodes(count: number = 8): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const code = randomBytes(4).toString('hex').toUpperCase()
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return codes
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.replace('-', '').toLowerCase()).digest('hex')
}

export function verifyBackupCode(code: string, hash: string): boolean {
  return hashBackupCode(code) === hash
}
