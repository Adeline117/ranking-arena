import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

describe('record provenance copy', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja],
    ['ko', ko],
  ])('distinguishes capture time and unknown freshness in %s', (_language, dictionary) => {
    expect(dictionary.recordProvenanceSourceAsOf.trim()).not.toBe('')
    expect(dictionary.recordProvenanceObservedAt.trim()).not.toBe('')
    expect(dictionary.recordProvenanceUnknown.trim()).not.toBe('')
    expect(dictionary.recordProvenanceSourceAsOf).not.toBe(dictionary.recordProvenanceObservedAt)
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja],
    ['ko', ko],
  ])('keeps verified copier figures distinct from a live roster in %s', (_language, dictionary) => {
    expect(dictionary.copierAggregateNotice.trim()).not.toBe('')
    expect(dictionary.copierVerifiedCaptureNotice.trim()).not.toBe('')
    expect(dictionary.copierVerifiedCaptureNotice).not.toBe(dictionary.copierAggregateNotice)
  })

  it.each([
    ['en', en, 'not a live roster'],
    ['zh', zh, '并非实时名单'],
    ['ja', ja, 'リアルタイムの一覧ではありません'],
    ['ko', ko, '실시간 목록이 아닙니다'],
  ])('does not present a verified capture as live data in %s', (_language, dictionary, copy) => {
    expect(dictionary.copierVerifiedCaptureNotice).toContain(copy)
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja],
    ['ko', ko],
  ])(
    'keeps a failed refresh distinct from loading and total unavailability in %s',
    (_language, dictionary) => {
      expect(dictionary.moduleRefreshFailed.trim()).not.toBe('')
      expect(dictionary.moduleRefreshFailed).not.toBe(dictionary.moduleDataPending)
      expect(dictionary.moduleRefreshFailed).not.toBe(dictionary.moduleDataUnavailable)
    }
  )
})
