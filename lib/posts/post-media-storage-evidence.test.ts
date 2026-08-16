import { hasExactPostMediaStorageEvidence } from './post-media-storage-evidence'

const evidence = {
  objectName: 'owner/videos/object.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 24,
} as const

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'object.mp4',
    metadata: { size: 24, contentLength: 24, mimetype: 'video/mp4' },
    ...overrides,
  }
}

describe('post media Storage evidence', () => {
  it('accepts one exact object listing', () => {
    expect(hasExactPostMediaStorageEvidence([stored()], evidence)).toBe(true)
  })

  it('accepts an older exact listing without redundant contentLength', () => {
    expect(
      hasExactPostMediaStorageEvidence(
        [stored({ metadata: { size: 24, mimetype: 'video/mp4' } })],
        evidence
      )
    ).toBe(true)
  })

  it.each([
    ['non-array response', null],
    ['missing object', []],
    ['wrong basename', [stored({ name: 'other.mp4' })]],
    ['duplicate exact entries', [stored(), stored({ id: 'other-id' })]],
    ['folder/null id', [stored({ id: null })]],
    ['missing metadata', [stored({ metadata: null })]],
    ['wrong size', [stored({ metadata: { size: 25, contentLength: 25, mimetype: 'video/mp4' } })]],
    ['wrong MIME', [stored({ metadata: { size: 24, contentLength: 24, mimetype: 'video/webm' } })]],
    [
      'contradictory content length',
      [stored({ metadata: { size: 24, contentLength: 23, mimetype: 'video/mp4' } })],
    ],
  ])('rejects %s', (_label, listing) => {
    expect(hasExactPostMediaStorageEvidence(listing, evidence)).toBe(false)
  })
})
