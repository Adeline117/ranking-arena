import {
  collectOwnedPostVideoObjectPaths,
  MAX_POST_VIDEO_CLEANUP_CANDIDATES,
  postVideoPublicPathMarker,
  readOwnedPostVideoObjectPath,
} from './post-media-storage-path'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORAGE_BASE_URL = 'https://project.supabase.co'

function publicUrl(path: string): string {
  return `${STORAGE_BASE_URL}/storage/v1/object/public/posts/${path}`
}

describe('post media storage paths', () => {
  it.each(['mp4', 'mov', 'webm', 'mkv', 'avi'])(
    'reads an owner-bound %s video path',
    (extension) => {
      const path = `${OWNER}/videos/${OBJECT}.${extension}`
      expect(readOwnedPostVideoObjectPath(publicUrl(path), OWNER, STORAGE_BASE_URL)).toBe(path)
    }
  )

  it.each([
    ['foreign owner', publicUrl(`${OTHER}/videos/${OBJECT}.mp4`)],
    ['image path', publicUrl(`${OWNER}/${OBJECT}.webp`)],
    [
      'foreign origin',
      `https://evil.example/storage/v1/object/public/posts/${OWNER}/videos/${OBJECT}.mp4`,
    ],
    ['path suffix', `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}/extra`],
    ['query string', `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}?download=1`],
    ['fragment', `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}#preview`],
    [
      'credentials',
      `https://user:pass@project.supabase.co/storage/v1/object/public/posts/${OWNER}/videos/${OBJECT}.mp4`,
    ],
    [
      'encoded separator',
      `${STORAGE_BASE_URL}/storage/v1/object/public/posts/${OWNER}%2Fvideos%2F${OBJECT}.mp4`,
    ],
    ['non-canonical case', publicUrl(`${OWNER}/videos/${OBJECT.toUpperCase()}.MP4`)],
    ['unsupported extension', publicUrl(`${OWNER}/videos/${OBJECT}.html`)],
  ])('rejects %s', (_label, value) => {
    expect(readOwnedPostVideoObjectPath(value, OWNER, STORAGE_BASE_URL)).toBeNull()
  })

  it('collects canonical Markdown/raw URLs once and excludes foreign or image objects', () => {
    const ownedPath = `${OWNER}/videos/${OBJECT}.mp4`
    const ownedUrl = publicUrl(ownedPath)
    const content = [
      `[video](${ownedUrl})`,
      ownedUrl,
      `![image](${publicUrl(`${OWNER}/${OBJECT}.webp`)})`,
      `[foreign](${publicUrl(`${OTHER}/videos/${OBJECT}.mp4`)})`,
    ].join('\n')

    expect(collectOwnedPostVideoObjectPaths(content, OWNER, STORAGE_BASE_URL)).toEqual([ownedPath])
    expect(postVideoPublicPathMarker(ownedPath)).toBe(
      `/storage/v1/object/public/posts/${ownedPath}`
    )
  })

  it('bounds attacker-controlled candidates before route-level reference queries', () => {
    const paths = Array.from({ length: MAX_POST_VIDEO_CLEANUP_CANDIDATES + 3 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, '0')
      return `${OWNER}/videos/aaaaaaaa-aaaa-4aaa-8aaa-${suffix}.mp4`
    })
    const content = paths.map(publicUrl).join('\n')

    expect(collectOwnedPostVideoObjectPaths(content, OWNER, STORAGE_BASE_URL)).toHaveLength(
      MAX_POST_VIDEO_CLEANUP_CANDIDATES
    )
  })
})
