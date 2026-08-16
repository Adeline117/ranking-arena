import {
  classifyPostMediaStorageUrl,
  collectPostMediaClaimObjectPaths,
  collectOwnedPostVideoObjectPaths,
  MAX_POST_MEDIA_CLAIM_OBJECT_PATHS,
  MAX_POST_VIDEO_CLEANUP_CANDIDATES,
  postVideoPublicPathMarker,
  readOwnedPostVideoObjectPath,
} from './post-media-storage-path'

const OWNER = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORAGE_BASE_URL = 'https://project.supabase.co'

function publicUrl(path: string): string {
  return `${STORAGE_BASE_URL}/storage/v1/object/public/posts/${path}`
}

describe('post media storage paths', () => {
  describe('classifyPostMediaStorageUrl', () => {
    it.each(['jpg', 'png', 'gif', 'webp', 'avif'])(
      'classifies a canonical owner-bound %s image and exposes its object path',
      (extension) => {
        const objectPath = `${OWNER}/${OBJECT}.${extension}`
        expect(classifyPostMediaStorageUrl(publicUrl(objectPath), OWNER, STORAGE_BASE_URL)).toEqual(
          {
            kind: 'owned-image',
            objectPath,
          }
        )
      }
    )

    it.each(['mp4', 'mov', 'webm', 'mkv', 'avi'])(
      'classifies a canonical owner-bound %s video and exposes its object path',
      (extension) => {
        const objectPath = `${OWNER}/videos/${OBJECT}.${extension}`
        expect(classifyPostMediaStorageUrl(publicUrl(objectPath), OWNER, STORAGE_BASE_URL)).toEqual(
          {
            kind: 'owned-video',
            objectPath,
          }
        )
      }
    )

    it.each([null, undefined, '', '   '])('classifies an absent value as none', (value) => {
      expect(classifyPostMediaStorageUrl(value, OWNER, STORAGE_BASE_URL)).toEqual({ kind: 'none' })
    })

    it.each([
      'https://cdn.example.test/media/photo.webp',
      'http://legacy.example.test/video.mp4?token=one#preview',
      `https://project.supabase.co.evil.example/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      'https://project.supabase.co/storage/v1/object/public/other-bucket/photo.webp',
    ])('classifies a valid non-posts URL as external: %s', (value) => {
      expect(classifyPostMediaStorageUrl(value, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'external',
      })
    })

    it.each([
      ['foreign image owner', publicUrl(`${OTHER}/${OBJECT}.webp`)],
      ['foreign video owner', publicUrl(`${OTHER}/videos/${OBJECT}.mp4`)],
      ['nested image path', publicUrl(`${OWNER}/images/${OBJECT}.webp`)],
      ['missing video directory', publicUrl(`${OWNER}/${OBJECT}.mp4`)],
      ['image path suffix', `${publicUrl(`${OWNER}/${OBJECT}.webp`)}/extra`],
      ['video path suffix', `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}/extra`],
      ['unsupported image extension', publicUrl(`${OWNER}/${OBJECT}.jpeg`)],
      ['unsupported video extension', publicUrl(`${OWNER}/videos/${OBJECT}.mpeg`)],
      ['encoded image separator', publicUrl(`${OWNER}%2F${OBJECT}.webp`)],
      ['encoded video separators', publicUrl(`${OWNER}%2Fvideos%2F${OBJECT}.mp4`)],
      [
        'encoded posts-prefix separator',
        `${STORAGE_BASE_URL}/storage/v1/object/public/posts%2F${OWNER}%2F${OBJECT}.webp`,
      ],
      [
        'encoded posts-prefix letter',
        `${STORAGE_BASE_URL}/storage/v1/object/public/%70osts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'posts-prefix dot traversal',
        `${STORAGE_BASE_URL}/storage/v1/object/public/posts/${OWNER}/../../../other/photo.webp`,
      ],
      ['image query string', `${publicUrl(`${OWNER}/${OBJECT}.webp`)}?download=1`],
      ['video fragment', `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}#preview`],
      [
        'credentials',
        `https://user:pass@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'posts-prefix case',
        `${STORAGE_BASE_URL}/storage/v1/object/public/POSTS/${OWNER}/${OBJECT}.webp`,
      ],
      ['owner case', publicUrl(`${OWNER.toUpperCase()}/${OBJECT}.webp`)],
      ['object case', publicUrl(`${OWNER}/${OBJECT.toUpperCase()}.WEBP`)],
      [
        'origin case',
        `https://PROJECT.SUPABASE.CO/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'explicit default port',
        `https://project.supabase.co:443/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
    ])('fails closed for a non-canonical internal %s', (_label, value) => {
      expect(classifyPostMediaStorageUrl(value, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-internal',
      })
    })

    it.each([
      ['malformed non-empty value', 'not a URL'],
      ['relative value', `/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`],
      ['non-http value', `data:image/webp;base64,${OBJECT}`],
      ['non-string value', 42],
      ['external credentials', 'https://user:pass@cdn.example.test/photo.webp'],
      ['leading whitespace', ` ${publicUrl(`${OWNER}/${OBJECT}.webp`)}`],
      ['control character', `https://cdn.example.test/photo.webp\n`],
    ])('does not downgrade an invalid non-empty %s to external', (_label, value) => {
      expect(classifyPostMediaStorageUrl(value, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-internal',
      })
    })

    it.each([
      ['empty URL', ''],
      ['malformed URL', 'not a URL'],
      ['non-http URL', 'ftp://project.supabase.co'],
      ['credentials', 'https://user:pass@project.supabase.co'],
      ['path', 'https://project.supabase.co/project'],
      ['query', 'https://project.supabase.co?project=one'],
      ['fragment', 'https://project.supabase.co#project'],
      ['whitespace', ' https://project.supabase.co'],
      ['non-canonical origin case', 'https://PROJECT.SUPABASE.CO'],
    ])('reports invalid storage configuration for %s', (_label, storageBaseUrl) => {
      expect(
        classifyPostMediaStorageUrl('https://cdn.example.test/photo.webp', OWNER, storageBaseUrl)
      ).toEqual({ kind: 'invalid-configuration' })
    })

    it('reports an invalid owner identity as configuration failure', () => {
      expect(
        classifyPostMediaStorageUrl(
          publicUrl(`${OWNER}/${OBJECT}.webp`),
          'not-an-owner-id',
          STORAGE_BASE_URL
        )
      ).toEqual({ kind: 'invalid-configuration' })
    })

    it('accepts the canonical storage origin with a trailing slash', () => {
      const objectPath = `${OWNER}/${OBJECT}.webp`
      expect(
        classifyPostMediaStorageUrl(publicUrl(objectPath), OWNER, `${STORAGE_BASE_URL}/`)
      ).toEqual({ kind: 'owned-image', objectPath })
    })
  })

  describe('collectPostMediaClaimObjectPaths', () => {
    it('returns an empty manifest for an empty final post', () => {
      expect(collectPostMediaClaimObjectPaths([], '', OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'ok',
        objectPaths: [],
      })
    })

    it('ignores valid external image and content URLs', () => {
      expect(
        collectPostMediaClaimObjectPaths(
          ['https://cdn.example.test/photo.webp'],
          '[video](https://video.example.test/clip.mp4)',
          OWNER,
          STORAGE_BASE_URL
        )
      ).toEqual({ kind: 'ok', objectPaths: [] })
    })

    it('collects final images and Markdown videos once in deterministic ASCII order', () => {
      const firstImageObject = '11111111-1111-4111-8111-111111111111'
      const secondImageObject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const videoObject = '22222222-2222-4222-8222-222222222222'
      const firstImagePath = `${OWNER}/${firstImageObject}.webp`
      const secondImagePath = `${OWNER}/${secondImageObject}.png`
      const videoPath = `${OWNER}/videos/${videoObject}.mp4`
      const videoUrl = publicUrl(videoPath)

      expect(
        collectPostMediaClaimObjectPaths(
          [publicUrl(secondImagePath), publicUrl(firstImagePath), publicUrl(firstImagePath)],
          [`[video](${videoUrl})`, videoUrl].join('\n'),
          OWNER,
          STORAGE_BASE_URL
        )
      ).toEqual({
        kind: 'ok',
        objectPaths: [firstImagePath, secondImagePath, videoPath],
      })
    })

    it.each([
      ['managed video in the final image list', [publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)], ''],
      ['managed image in final content', [], `![image](${publicUrl(`${OWNER}/${OBJECT}.webp`)})`],
    ])('fails closed for a %s', (_label, images, content) => {
      expect(collectPostMediaClaimObjectPaths(images, content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
    })

    it.each([
      ['foreign image owner', [publicUrl(`${OTHER}/${OBJECT}.webp`)], ''],
      ['foreign video owner', [], publicUrl(`${OTHER}/videos/${OBJECT}.mp4`)],
      ['malformed managed image', [`${publicUrl(`${OWNER}/${OBJECT}.webp`)}?download=1`], ''],
      ['malformed managed video', [], `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}#preview`],
    ])('rejects a %s instead of omitting it from the claim manifest', (_label, images, content) => {
      expect(collectPostMediaClaimObjectPaths(images, content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
    })

    it('distinguishes invalid server configuration from an invalid media reference', () => {
      expect(
        collectPostMediaClaimObjectPaths(
          ['https://cdn.example.test/photo.webp'],
          '',
          OWNER,
          `${STORAGE_BASE_URL}/project`
        )
      ).toEqual({ kind: 'invalid-configuration' })
    })

    it('rejects a deduplicated manifest above the 64-object authority bound', () => {
      const content = Array.from({ length: MAX_POST_MEDIA_CLAIM_OBJECT_PATHS + 1 }, (_, index) => {
        const suffix = index.toString(16).padStart(12, '0')
        return publicUrl(`${OWNER}/videos/aaaaaaaa-aaaa-4aaa-8aaa-${suffix}.mp4`)
      }).join('\n')

      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
    })
  })

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
