import {
  getHandleCodePointLength,
  getHandleShapeError,
  isReservedHandle,
  MAX_HANDLE_LENGTH,
  normalizeHandle,
  truncateHandle,
} from '../handle-policy'

describe('canonical handle policy', () => {
  it.each([
    'a',
    'Alice_123',
    '交易员甲',
    'ひらがな',
    'カタカナ',
    '거래자',
    'A_交易_ひら_カナ_거래',
    '\u4E00\u9FAF\u3041\u309F\u30A0\u30FF\uAC00\uD7A3',
  ])('accepts a new NFC handle in the database alphabet: %s', (handle) => {
    expect(getHandleShapeError(handle)).toBeNull()
  })

  it('uses Unicode code points and enforces the database length ceiling', () => {
    expect(getHandleShapeError('界'.repeat(MAX_HANDLE_LENGTH))).toBeNull()
    expect(getHandleShapeError('界'.repeat(MAX_HANDLE_LENGTH + 1))).toBe('too_long')
    expect(getHandleCodePointLength('界'.repeat(MAX_HANDLE_LENGTH))).toBe(MAX_HANDLE_LENGTH)
  })

  it('requires NFC and exposes one canonical normalization helper', () => {
    const decomposedKana = '\u306F\u3099'
    expect(normalizeHandle(decomposedKana)).toBe('\u3070')
    expect(getHandleShapeError(decomposedKana)).toBe('not_normalized')
    expect(getHandleShapeError(normalizeHandle(decomposedKana))).toBeNull()
  })

  it.each([
    ['new.dotted.name', 'invalid_characters'],
    ['bad/name', 'invalid_characters'],
    ['bad\\name', 'invalid_characters'],
    ['bad?query', 'invalid_characters'],
    ['bad#fragment', 'invalid_characters'],
    ['bad%2Fescape', 'invalid_characters'],
    ['bad name', 'invalid_characters'],
    ['bad-name', 'invalid_characters'],
    ['safe\u202Eeman', 'invalid_characters'],
    ['safe\u200Bname', 'invalid_characters'],
    ['emoji😀', 'invalid_characters'],
    ['é', 'invalid_characters'],
    ['___', 'missing_name_character'],
    ['', 'required'],
  ])('rejects a new unsafe handle %j', (handle, error) => {
    expect(getHandleShapeError(handle)).toBe(error)
  })

  it('accepts only an explicitly opted-in safe legacy dotted shape', () => {
    expect(getHandleShapeError('legacy.user')).toBe('invalid_characters')
    expect(getHandleShapeError('legacy.user', { allowUnchangedLegacyDot: true })).toBeNull()
    expect(getHandleShapeError('...', { allowUnchangedLegacyDot: true })).toBe(
      'missing_name_character'
    )
    expect(getHandleShapeError('legacy/user', { allowUnchangedLegacyDot: true })).toBe(
      'invalid_characters'
    )
  })

  it('matches the database reserved-handle set case-insensitively', () => {
    expect(isReservedHandle('Administrator')).toBe(true)
    expect(isReservedHandle('OFFICIAL')).toBe(true)
    expect(isReservedHandle('ordinary_user')).toBe(false)
  })

  it('normalizes before truncating to the database code-point ceiling', () => {
    const result = truncateHandle(`${'界'.repeat(MAX_HANDLE_LENGTH - 1)}\u306F\u3099tail`)
    expect(result.endsWith('\u3070')).toBe(true)
    expect(getHandleCodePointLength(result)).toBe(MAX_HANDLE_LENGTH)
    expect(result).toBe(normalizeHandle(result))
  })
})
