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
})
