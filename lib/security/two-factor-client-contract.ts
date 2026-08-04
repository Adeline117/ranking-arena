export const TWO_FACTOR_BACKUP_CODE_COUNT = 8

const TOTP_SECRET_PATTERN = /^[A-Z2-7]{16,128}$/
const BACKUP_CODE_PATTERN = /^[A-F0-9]{4}-[A-F0-9]{4}$/
const PNG_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

export function isValidTwoFactorBackupCodeSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== TWO_FACTOR_BACKUP_CODE_COUNT) return false
  if (!value.every((code) => typeof code === 'string' && BACKUP_CODE_PATTERN.test(code))) {
    return false
  }
  return new Set(value).size === TWO_FACTOR_BACKUP_CODE_COUNT
}

export function readTwoFactorSetupAcknowledgement(
  value: unknown,
  expectedViewerId: string
): { qrCodeDataUrl: string; secret: string } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['success', 'viewerId', 'status', 'qrCode', 'secret']) ||
    value.success !== true ||
    value.viewerId !== expectedViewerId ||
    value.status !== 'staged' ||
    typeof value.secret !== 'string' ||
    !TOTP_SECRET_PATTERN.test(value.secret) ||
    typeof value.qrCode !== 'string' ||
    value.qrCode.length > 512 * 1024 ||
    !PNG_DATA_URL_PATTERN.test(value.qrCode)
  ) {
    return null
  }

  return { qrCodeDataUrl: value.qrCode, secret: value.secret }
}

export function readTwoFactorEnableAcknowledgement(
  value: unknown,
  expectedViewerId: string
): string[] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['success', 'viewerId', 'status', 'backupCodes']) ||
    value.success !== true ||
    value.viewerId !== expectedViewerId ||
    value.status !== 'enabled' ||
    !isValidTwoFactorBackupCodeSet(value.backupCodes)
  ) {
    return null
  }
  return [...value.backupCodes]
}

export function readTwoFactorDisableAcknowledgement(
  value: unknown,
  expectedViewerId: string
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['success', 'viewerId', 'status']) &&
    value.success === true &&
    value.viewerId === expectedViewerId &&
    value.status === 'disabled'
  )
}

export function readTwoFactorBackupCodeRotationAcknowledgement(
  value: unknown,
  expectedViewerId: string
): string[] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['success', 'viewerId', 'status', 'backupCodes']) ||
    value.success !== true ||
    value.viewerId !== expectedViewerId ||
    value.status !== 'rotated' ||
    !isValidTwoFactorBackupCodeSet(value.backupCodes)
  ) {
    return null
  }
  return [...value.backupCodes]
}
