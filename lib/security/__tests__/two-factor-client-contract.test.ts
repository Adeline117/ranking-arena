import {
  isValidTwoFactorBackupCodeSet,
  readTwoFactorBackupCodeRotationAcknowledgement,
  readTwoFactorDisableAcknowledgement,
  readTwoFactorEnableAcknowledgement,
  readTwoFactorSetupAcknowledgement,
} from '../two-factor-client-contract'

const VIEWER = '10000000-0000-4000-8000-000000000001'
const SECRET = 'JBSWY3DPEHPK3PXP'
const BACKUP_CODES = [
  '0001-0001',
  '0002-0002',
  '0003-0003',
  '0004-0004',
  '0005-0005',
  '0006-0006',
  '0007-0007',
  '0008-0008',
]

function setupAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    viewerId: VIEWER,
    status: 'staged',
    qrCode: 'data:image/png;base64,aGVsbG8=',
    secret: SECRET,
    ...overrides,
  }
}

function enableAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    viewerId: VIEWER,
    status: 'enabled',
    backupCodes: BACKUP_CODES,
    ...overrides,
  }
}

describe('two-factor client response contracts', () => {
  it('accepts the exact setup material bound to the viewer and URI secret', () => {
    expect(readTwoFactorSetupAcknowledgement(setupAcknowledgement(), VIEWER)).toEqual({
      qrCodeDataUrl: 'data:image/png;base64,aGVsbG8=',
      secret: SECRET,
    })
  })

  it.each([
    ['another viewer', setupAcknowledgement({ viewerId: 'other-user' })],
    ['another status', setupAcknowledgement({ status: 'enabled' })],
    ['an invalid secret', setupAcknowledgement({ secret: 'plaintext' })],
    ['a remote QR URL', setupAcknowledgement({ qrCode: 'https://example.com/qr.png' })],
    ['an extra field', setupAcknowledgement({ admin: true })],
  ])('rejects setup acknowledgement with %s', (_label, value) => {
    expect(readTwoFactorSetupAcknowledgement(value, VIEWER)).toBeNull()
  })

  it('accepts one exact unique recovery-code set', () => {
    expect(isValidTwoFactorBackupCodeSet(BACKUP_CODES)).toBe(true)
    expect(readTwoFactorEnableAcknowledgement(enableAcknowledgement(), VIEWER)).toEqual(
      BACKUP_CODES
    )
    expect(
      readTwoFactorBackupCodeRotationAcknowledgement(
        { ...enableAcknowledgement(), status: 'rotated' },
        VIEWER
      )
    ).toEqual(BACKUP_CODES)
  })

  it.each([
    ['missing codes', enableAcknowledgement({ backupCodes: [] })],
    [
      'duplicate codes',
      enableAcknowledgement({ backupCodes: [...BACKUP_CODES.slice(0, 7), BACKUP_CODES[0]] }),
    ],
    ['malformed codes', enableAcknowledgement({ backupCodes: [...BACKUP_CODES.slice(0, 7), 'x'] })],
    ['another viewer', enableAcknowledgement({ viewerId: 'other-user' })],
    ['another status', enableAcknowledgement({ status: 'rotated' })],
    ['an extra field', enableAcknowledgement({ message: 'enabled' })],
  ])('rejects enabled acknowledgement with %s', (_label, value) => {
    expect(readTwoFactorEnableAcknowledgement(value, VIEWER)).toBeNull()
  })

  it('requires an exact viewer-bound disable acknowledgement', () => {
    expect(
      readTwoFactorDisableAcknowledgement(
        { success: true, viewerId: VIEWER, status: 'disabled' },
        VIEWER
      )
    ).toBe(true)
    expect(
      readTwoFactorDisableAcknowledgement(
        { success: true, viewerId: VIEWER, status: 'disabled', codesDeleted: true },
        VIEWER
      )
    ).toBe(false)
    expect(
      readTwoFactorDisableAcknowledgement(
        { success: true, viewerId: 'other-user', status: 'disabled' },
        VIEWER
      )
    ).toBe(false)
  })
})
