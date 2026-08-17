import {
  classifyPostMediaStorageUrl,
  collectPostMediaClaimObjectPaths,
  collectOwnedPostVideoObjectPaths,
  MAX_POST_MEDIA_CLAIM_OBJECT_PATHS,
  MAX_POST_VIDEO_CLEANUP_CANDIDATES,
  postVideoPublicPathMarker,
  readCanonicalPostMediaStorageOrigin,
  readOwnedPostVideoObjectPath,
} from './post-media-storage-path'
import { parseContent } from '../utils/content'

const OWNER = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORAGE_BASE_URL = 'https://project.supabase.co'

function publicUrl(path: string): string {
  return `${STORAGE_BASE_URL}/storage/v1/object/public/posts/${path}`
}

describe('post media storage paths', () => {
  describe('readCanonicalPostMediaStorageOrigin', () => {
    it.each([
      ['canonical HTTPS origin', STORAGE_BASE_URL],
      ['canonical HTTPS origin with one trailing slash', `${STORAGE_BASE_URL}/`],
      ['canonical HTTP origin', 'http://localhost:54321'],
      ['canonical HTTP origin with one trailing slash', 'http://localhost:54321/'],
    ])('normalizes a %s', (_label, value) => {
      expect(readCanonicalPostMediaStorageOrigin(value)).toBe(new URL(value).origin)
    })

    it.each([
      ['non-string value', 42],
      ['empty URL', ''],
      ['malformed URL', 'not a URL'],
      ['non-http URL', 'ftp://project.supabase.co'],
      ['credentials', 'https://user:pass@project.supabase.co'],
      ['path', 'https://project.supabase.co/project'],
      ['query', 'https://project.supabase.co?project=one'],
      ['fragment', 'https://project.supabase.co#project'],
      ['leading whitespace', ' https://project.supabase.co'],
      ['trailing whitespace', 'https://project.supabase.co '],
      ['control character', 'https://project.supabase.co\n'],
      ['two trailing slashes', 'https://project.supabase.co//'],
      ['non-canonical host case', 'https://PROJECT.SUPABASE.CO'],
      ['explicit default port', 'https://project.supabase.co:443'],
    ])('rejects a %s', (_label, value) => {
      expect(readCanonicalPostMediaStorageOrigin(value)).toBeNull()
    })
  })

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
      [
        'same-host HTTP image route',
        `http://project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'same-host HTTP video route',
        `http://project.supabase.co/storage/v1/object/public/posts/${OWNER}/videos/${OBJECT}.mp4`,
      ],
      [
        'same-host alternate port',
        `https://project.supabase.co:444/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'DNS root-dot hostname',
        `https://project.supabase.co./storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'image render route',
        `https://project.supabase.co/storage/v1/render/image/public/posts/${OWNER}/${OBJECT}.webp?width=100`,
      ],
      [
        'signed object route',
        `https://project.supabase.co/storage/v1/object/sign/posts/${OWNER}/${OBJECT}.webp?token=one`,
      ],
      [
        'authenticated object route',
        `https://project.supabase.co/storage/v1/object/authenticated/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'canonical-host S3 path-style route',
        `https://project.supabase.co/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`,
      ],
      [
        'official direct-host S3 path-style route',
        `https://project.storage.supabase.co/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`,
      ],
      [
        'official direct-host S3 HTTP route',
        `http://project.storage.supabase.co/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`,
      ],
      [
        'official direct-host S3 DNS root-dot route',
        `https://project.storage.supabase.co./storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`,
      ],
      [
        'official direct-host public object route',
        `https://project.storage.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'zero-padded default port',
        `https://project.supabase.co:000443/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'percent-encoded host',
        `https://%70roject.supabase%2Eco/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'backslash authority and path',
        String.raw`https:\\project.supabase.co\storage\v1\object\public\posts\${OWNER}\${OBJECT}.webp`,
      ],
      [
        'mixed slash authority',
        String.raw`https:/\project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'slashless special-scheme URL',
        `https:project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
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

    it('collects final images and Markdown media once in deterministic ASCII order', () => {
      const firstImageObject = '11111111-1111-4111-8111-111111111111'
      const secondImageObject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const videoObject = '22222222-2222-4222-8222-222222222222'
      const firstImagePath = `${OWNER}/${firstImageObject}.webp`
      const secondImagePath = `${OWNER}/${secondImageObject}.png`
      const videoPath = `${OWNER}/videos/${videoObject}.mp4`
      const videoUrl = publicUrl(videoPath)
      const firstImageUrl = publicUrl(firstImagePath)

      expect(
        collectPostMediaClaimObjectPaths(
          [publicUrl(secondImagePath), firstImageUrl, firstImageUrl],
          [`![image](${firstImageUrl})`, `[video](${videoUrl})`, videoUrl].join('\n'),
          OWNER,
          STORAGE_BASE_URL
        )
      ).toEqual({
        kind: 'ok',
        objectPaths: [firstImagePath, secondImagePath, videoPath],
      })
    })

    it('collects a managed image referenced only by Markdown content', () => {
      const imagePath = `${OWNER}/${OBJECT}.webp`
      expect(
        collectPostMediaClaimObjectPaths(
          [],
          `![image](${publicUrl(imagePath)})`,
          OWNER,
          STORAGE_BASE_URL
        )
      ).toEqual({
        kind: 'ok',
        objectPaths: [imagePath],
      })
    })

    it.each(['video', 'VIDEO', '视频', '動画', '동영상'])(
      'collects a canonical managed video once from the persisted %s marker',
      (label) => {
        const videoPath = `${OWNER}/videos/${OBJECT}.mp4`
        expect(
          collectPostMediaClaimObjectPaths(
            [],
            `[${label}](${publicUrl(videoPath)})`,
            OWNER,
            STORAGE_BASE_URL
          )
        ).toEqual({
          kind: 'ok',
          objectPaths: [videoPath],
        })
      }
    )

    it.each([
      ['video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
      ['视频', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ])('keeps an external %s marker out of the managed manifest', (label, url) => {
      expect(
        collectPostMediaClaimObjectPaths([], `[${label}](${url})`, OWNER, STORAGE_BASE_URL)
      ).toEqual({ kind: 'ok', objectPaths: [] })
    })

    it('rejects managed userinfo hidden in a persisted video marker', () => {
      const videoPath = `${OWNER}/videos/${OBJECT}.mp4`
      const url = `https://user:password@project.supabase.co/storage/v1/object/public/posts/${videoPath}`

      expect(
        collectPostMediaClaimObjectPaths([], `[video](${url})`, OWNER, STORAGE_BASE_URL)
      ).toEqual({ kind: 'invalid-reference' })
    })

    it('fails closed for a managed video in the final image list', () => {
      expect(
        collectPostMediaClaimObjectPaths(
          [publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)],
          '',
          OWNER,
          STORAGE_BASE_URL
        )
      ).toEqual({ kind: 'invalid-reference' })
    })

    it.each([
      ['foreign image owner', [publicUrl(`${OTHER}/${OBJECT}.webp`)], ''],
      ['foreign video owner', [], publicUrl(`${OTHER}/videos/${OBJECT}.mp4`)],
      ['malformed managed image', [`${publicUrl(`${OWNER}/${OBJECT}.webp`)}?download=1`], ''],
      ['malformed managed video', [], `${publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)}#preview`],
      [
        'same-host HTTP image',
        [`http://project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`],
        '',
      ],
      [
        'same-host HTTP direct video',
        [],
        `http://project.supabase.co/storage/v1/object/public/posts/${OWNER}/videos/${OBJECT}.mp4`,
      ],
      [
        'render-route Markdown image',
        [],
        `![image](https://project.supabase.co/storage/v1/render/image/public/posts/${OWNER}/${OBJECT}.webp?width=100)`,
      ],
      [
        'signed image URL',
        [
          `https://project.supabase.co/storage/v1/object/sign/posts/${OWNER}/${OBJECT}.webp?token=one`,
        ],
        '',
      ],
      [
        'signed raw direct video',
        [],
        `https://project.supabase.co/storage/v1/object/sign/posts/${OWNER}/videos/${OBJECT}.mp4?token=one`,
      ],
      [
        'direct-host S3 image URL',
        [
          `https://project.storage.supabase.co/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`,
        ],
        '',
      ],
      [
        'direct-host S3 Markdown image',
        [],
        `![image](https://project.storage.supabase.co/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one)`,
      ],
      [
        'direct-host S3 raw video',
        [],
        `https://project.storage.supabase.co/storage/v1/s3/posts/${OWNER}/videos/${OBJECT}.mp4?X-Amz-Signature=one`,
      ],
    ])('rejects a %s instead of omitting it from the claim manifest', (_label, images, content) => {
      expect(collectPostMediaClaimObjectPaths(images, content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
    })

    it.each([
      [
        'backslash authority and path',
        String.raw`https:\\project.supabase.co\storage\v1\object\public\posts\${OWNER}\${OBJECT}.webp`,
      ],
      [
        'mixed slash authority',
        String.raw`https:/\project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'single forward slash authority',
        `https:/project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'slashless special-scheme URL',
        `https:project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'percent-encoded host',
        `https://%70roject.supabase%2Eco/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'zero-padded default port',
        `https://project.supabase.co:000443/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'userinfo',
        `https://user:password@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
    ])('rejects a WHATWG-equivalent managed Markdown URL with %s', (_label, url) => {
      expect(
        collectPostMediaClaimObjectPaths([], `![image](${url})`, OWNER, STORAGE_BASE_URL)
      ).toEqual({
        kind: 'invalid-reference',
      })
    })

    it.each([
      [
        'backslash authority and path',
        String.raw`https:\\project.supabase.co\storage\v1\object\public\posts\${OWNER}\${OBJECT}.webp`,
      ],
      [
        'mixed slash authority',
        String.raw`https:/\project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'single forward slash authority',
        `https:/project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
      [
        'slashless special-scheme URL',
        `https:project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp`,
      ],
    ])('ignores non-rendered raw special-scheme text with %s', (_label, content) => {
      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'ok',
        objectPaths: [],
      })
    })

    it.each(['{', '}', '|', '^', '\\'])(
      'collects a managed raw video after the renderer delimiter %p',
      (delimiter) => {
        const videoPath = `${OWNER}/videos/${OBJECT}.mp4`
        const content = `https://evil.example/x${delimiter}${publicUrl(videoPath)}`

        expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
          kind: 'ok',
          objectPaths: [videoPath],
        })
      }
    )

    it.each(['{', '}', '|', '^', '\\'])(
      'collects a managed video inside a generic Markdown link after delimiter %p',
      (delimiter) => {
        const videoPath = `${OWNER}/videos/${OBJECT}.mp4`
        const content = `[video](https://evil.example/x${delimiter}${publicUrl(videoPath)})`

        expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
          kind: 'ok',
          objectPaths: [videoPath],
        })
      }
    )

    it('collects a renderer-reachable managed video from a generic Markdown link label', () => {
      const videoPath = `${OWNER}/videos/${OBJECT}.mp4`
      const videoUrl = publicUrl(videoPath)
      const content = `[${videoUrl}](https://evil.example/x)`

      expect(parseContent(content)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'video', content: videoUrl, url: videoUrl }),
        ])
      )
      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'ok',
        objectPaths: [videoPath],
      })
    })

    it('does not scan consumed Markdown image alt text as raw media', () => {
      const videoUrl = publicUrl(`${OWNER}/videos/${OBJECT}.mp4`)
      const content = `![${videoUrl}](https://cdn.example.test/image.webp)`

      expect(parseContent(content)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'video', url: videoUrl })])
      )
      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'ok',
        objectPaths: [],
      })
    })

    it.each([
      [
        'quoted userinfo',
        `![image](https://user'name@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp)`,
      ],
      [
        'bracketed userinfo',
        `![image](https://user[name]@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp)`,
      ],
      [
        'spaced userinfo',
        `![image](https://user name@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp)`,
      ],
      [
        'tab-normalized host',
        `![image](https://project.supa\tbase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp)`,
      ],
    ])('rejects a managed Markdown destination with %s', (_label, content) => {
      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
    })

    it.each([
      ['slashless special-scheme URL', 'https:cdn.example.test/photo.webp'],
      ['backslash special-scheme URL', String.raw`https:\\cdn.example.test\photo.webp`],
      ['percent-encoded host', 'https://%63dn.example.test/photo.webp'],
      ['zero-padded default port', 'https://cdn.example.test:00443/photo.webp'],
      ['spaced Markdown path', '![image](https://cdn.example.test/photo name.webp)'],
    ])('continues to ignore a genuine external content URL with %s', (_label, content) => {
      expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'ok',
        objectPaths: [],
      })
    })

    it('does not infer unsupported S3 virtual-host or custom-domain mappings', () => {
      const virtualHost = `https://posts.project.storage.supabase.co/storage/v1/s3/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`
      const customHost = `https://project.storage.example.test/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`
      const customStorageBaseUrl = 'https://media.example.test'
      const inventedCustomAlias = `https://media.storage.example.test/storage/v1/s3/posts/${OWNER}/${OBJECT}.webp?X-Amz-Signature=one`

      expect(classifyPostMediaStorageUrl(virtualHost, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'external',
      })
      expect(classifyPostMediaStorageUrl(customHost, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'external',
      })
      expect(classifyPostMediaStorageUrl(inventedCustomAlias, OWNER, customStorageBaseUrl)).toEqual(
        {
          kind: 'external',
        }
      )
    })

    it.each(['\n', '\r'])(
      'does not claim a %p-spliced destination that the shared renderer grammar rejects',
      (lineBreak) => {
        const content = `![image](https://evil.example${lineBreak}@project.supabase.co/storage/v1/object/public/posts/${OWNER}/${OBJECT}.webp)`

        expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
          kind: 'ok',
          objectPaths: [],
        })
      }
    )

    it.each(["'", '(', ')'])(
      'rejects a renderer-reachable managed direct video with %p in userinfo',
      (delimiter) => {
        const content = `https://evil.example${delimiter}@project.supabase.co/storage/v1/object/public/posts/${OWNER}/videos/${OBJECT}.mp4`

        expect(new URL(content).origin).toBe(STORAGE_BASE_URL)
        expect(collectPostMediaClaimObjectPaths([], content, OWNER, STORAGE_BASE_URL)).toEqual({
          kind: 'invalid-reference',
        })
      }
    )

    it.each([
      '//storage/v1/object/public/posts',
      '/storage//v1/object/public/posts',
      '/storage/v1//object/public/posts',
      '/storage/v1/object//public/posts',
      '/storage/v1/object/public//posts',
    ])('rejects duplicate Storage route separators in %s', (routePrefix) => {
      const imageUrl = `${STORAGE_BASE_URL}${routePrefix}/${OWNER}/${OBJECT}.webp`
      const videoUrl = `${STORAGE_BASE_URL}${routePrefix}/${OWNER}/videos/${OBJECT}.mp4`

      expect(classifyPostMediaStorageUrl(imageUrl, OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-internal',
      })
      expect(collectPostMediaClaimObjectPaths([imageUrl], '', OWNER, STORAGE_BASE_URL)).toEqual({
        kind: 'invalid-reference',
      })
      expect(collectPostMediaClaimObjectPaths([], videoUrl, OWNER, STORAGE_BASE_URL)).toEqual({
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
