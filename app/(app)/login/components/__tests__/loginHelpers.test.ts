import { validateHandle } from '../loginHelpers'

describe('registration handle validation', () => {
  it('requires a non-empty handle and accepts the one-character database minimum', () => {
    expect(validateHandle('')).toEqual({
      valid: false,
      messageKey: 'loginHandleTooShort',
    })
    expect(validateHandle('a')).toEqual({ valid: true, messageKey: '' })
  })

  it.each(['Alice_123', '交易员甲', 'ひらがな', 'カタカナ', '거래자'])(
    'accepts a new NFC handle in the database alphabet: %s',
    (handle) => {
      expect(validateHandle(handle)).toEqual({ valid: true, messageKey: '' })
    }
  )

  it('maps the database code-point ceiling to the length error', () => {
    expect(validateHandle('界'.repeat(30))).toEqual({ valid: true, messageKey: '' })
    expect(validateHandle('界'.repeat(31))).toEqual({
      valid: false,
      messageKey: 'loginHandleTooLong',
    })
  })

  it.each([
    'new.dotted.name',
    'bad/name',
    'bad\\name',
    'bad?query',
    'bad#fragment',
    'bad%2Fescape',
    'bad name',
    'bad-name',
    'safe\u202Eeman',
    'safe\u200Bname',
    '\u306F\u3099',
    'é',
    'emoji😀',
    '___',
  ])('rejects a new unsafe or non-canonical handle: %s', (handle) => {
    expect(validateHandle(handle)).toEqual({
      valid: false,
      messageKey: 'loginHandleInvalidChars',
    })
  })

  it.each([
    'admin',
    'Administrator',
    'ARENA',
    'moderator',
    'official',
    'root',
    'support',
    'system',
  ])('rejects the database-reserved identity %s', (handle) => {
    expect(validateHandle(handle)).toEqual({ valid: false, messageKey: 'usernameInUse' })
  })
})
