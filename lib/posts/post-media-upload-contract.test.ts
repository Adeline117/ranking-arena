import {
  readPostImageUploadAcknowledgement,
  readPostMediaUploadError,
  readPostVideoUploadAcknowledgement,
} from './post-media-upload-contract'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORAGE_BASE_URL = 'https://project.supabase.co'

function publicUrl(path: string): string {
  return `https://project.supabase.co/storage/v1/object/public/posts/${path}`
}

describe('post media upload acknowledgement', () => {
  it('reads only a bounded non-empty upload error', () => {
    expect(readPostMediaUploadError({ error: ' Upload failed ' })).toBe('Upload failed')
    expect(readPostMediaUploadError({ error: '' })).toBeNull()
    expect(readPostMediaUploadError({ error: 500 })).toBeNull()
    expect(readPostMediaUploadError({ error: 'x'.repeat(501) })).toBeNull()
  })

  it('accepts an exact owner-bound image acknowledgement', () => {
    const fileName = `${OWNER}/${OBJECT}.webp`
    expect(
      readPostImageUploadAcknowledgement(
        { url: publicUrl(fileName), fileName, verified: true },
        OWNER,
        STORAGE_BASE_URL
      )
    ).toEqual({ url: publicUrl(fileName), fileName })
  })

  it.each([
    ['changed owner', { fileName: `${OTHER}/${OBJECT}.webp` }],
    ['unsupported extension', { fileName: `${OWNER}/${OBJECT}.svg` }],
    ['unverified', { verified: false }],
    ['foreign URL path', { url: 'https://evil.example/image.webp' }],
    [
      'foreign storage origin',
      { url: `https://evil.example/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp` },
    ],
    [
      'URL credentials',
      {
        url: `https://user:pass@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      },
    ],
    ['widened payload', { extra: true }],
  ])('rejects image evidence with %s', (_label, override) => {
    const fileName = `${OWNER}/${OBJECT}.webp`
    expect(
      readPostImageUploadAcknowledgement(
        { url: publicUrl(fileName), fileName, verified: true, ...override },
        OWNER,
        STORAGE_BASE_URL
      )
    ).toBeNull()
  })

  it.each([
    ['mp4', 'video/mp4'],
    ['mov', 'video/quicktime'],
    ['webm', 'video/webm'],
    ['mkv', 'video/x-matroska'],
    ['avi', 'video/x-msvideo'],
  ])('accepts exact %s video evidence', (extension, fileType) => {
    const fileName = `${OWNER}/videos/${OBJECT}.${extension}`
    expect(
      readPostVideoUploadAcknowledgement(
        { url: publicUrl(fileName), fileName, fileSize: 24, fileType },
        OWNER,
        STORAGE_BASE_URL
      )
    ).toEqual({ url: publicUrl(fileName), fileName, fileSize: 24, fileType })
  })

  it.each([
    ['changed owner', { fileName: `${OTHER}/videos/${OBJECT}.mp4` }],
    ['MIME mismatch', { fileType: 'video/webm' }],
    ['zero size', { fileSize: 0 }],
    ['oversized', { fileSize: 100 * 1024 * 1024 + 1 }],
    ['fractional size', { fileSize: 1.5 }],
    ['foreign URL', { url: 'https://evil.example/video.mp4' }],
    ['widened payload', { extra: true }],
  ])('rejects video evidence with %s', (_label, override) => {
    const fileName = `${OWNER}/videos/${OBJECT}.mp4`
    expect(
      readPostVideoUploadAcknowledgement(
        {
          url: publicUrl(fileName),
          fileName,
          fileSize: 24,
          fileType: 'video/mp4',
          ...override,
        },
        OWNER,
        STORAGE_BASE_URL
      )
    ).toBeNull()
  })
})
