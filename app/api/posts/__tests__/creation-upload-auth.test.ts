import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const profileCreatePage = readFileSync(resolve(root, 'app/(app)/u/[handle]/new/page.tsx'), 'utf8')
const profileMediaUploader = readFileSync(
  resolve(root, 'app/(app)/u/[handle]/new/components/MediaUploader.tsx'),
  'utf8'
)
const groupCreatePage = readFileSync(resolve(root, 'app/(app)/groups/[id]/new/page.tsx'), 'utf8')
const groupImageUploader = readFileSync(
  resolve(root, 'app/(app)/groups/[id]/new/components/ImageUploader.tsx'),
  'utf8'
)
const groupVideoUploader = readFileSync(
  resolve(root, 'app/(app)/groups/[id]/new/components/VideoUploader.tsx'),
  'utf8'
)

function functionBody(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function expectAuthenticatedXhr(body: string, endpoint: string): void {
  const open = body.indexOf(`xhr.open('POST', '${endpoint}')`)
  const auth = body.indexOf("xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`)")
  const send = body.indexOf('xhr.send(formData)')

  expect(body).toContain('tokenRefreshCoordinator.getValidToken()')
  expect(body).toContain('if (!uploadToken)')
  expect(open).toBeGreaterThanOrEqual(0)
  expect(auth).toBeGreaterThan(open)
  expect(send).toBeGreaterThan(auth)
}

describe('post creation media upload authentication', () => {
  it('authenticates profile video uploads before sending the body', () => {
    const body = functionBody(
      profileCreatePage,
      'const handleVideoUpload = async',
      '// Remove video'
    )
    expectAuthenticatedXhr(body, '/api/posts/upload-video')
  })

  it('authenticates group image uploads before sending the body', () => {
    const body = functionBody(
      groupCreatePage,
      'const handleImageUpload = useCallback',
      'const removeImage = useCallback'
    )
    expectAuthenticatedXhr(body, '/api/posts/upload-image')
  })

  it('authenticates group video uploads before sending the body', () => {
    const body = functionBody(
      groupCreatePage,
      'const handleVideoUpload = useCallback',
      'const removeVideo = useCallback'
    )
    expectAuthenticatedXhr(body, '/api/posts/upload-video')
  })

  it('persists a canonical video marker and structurally removes historical markers', () => {
    const profileUpload = functionBody(
      profileCreatePage,
      'const handleVideoUpload = async',
      '// Remove video'
    )
    const profileRemoval = functionBody(
      profileCreatePage,
      'const removeVideo = () =>',
      '// Remove image'
    )
    const groupUpload = functionBody(
      groupCreatePage,
      'const handleVideoUpload = useCallback',
      'const removeVideo = useCallback'
    )
    const groupRemoval = functionBody(
      groupCreatePage,
      'const removeVideo = useCallback',
      'const handleSubmit = async'
    )

    expect(profileUpload).toContain('const videoMarkdown = `\\n[video](${data.url})\\n`')
    expect(profileUpload).not.toContain("t('video')")
    expect(groupUpload).toContain('setContent((prev) => prev + `\\n[video](${data.url})\\n`)')

    for (const removal of [profileRemoval, groupRemoval]) {
      expect(removal).toContain('removeMarkdownVideoMarkers(prev).content')
      expect(removal).not.toContain('.replace(')
    }
  })

  it('removes a tray image from both attachment state and exact Markdown references', () => {
    const profileRemoval = functionBody(
      profileCreatePage,
      'const removeImage = (index: number) =>',
      '// Image drag reorder'
    )
    const groupRemoval = functionBody(
      groupCreatePage,
      'const removeImage = useCallback',
      'const insertImageToContent = useCallback'
    )

    for (const removal of [profileRemoval, groupRemoval]) {
      expect(removal).toContain('const target = images[index]')
      expect(removal).toContain('if (!target) return')
      expect(removal).toContain(
        'setImages((prev) => prev.filter((image) => image.url !== target.url))'
      )
      expect(removal).toContain(
        'setContent((prev) => removeMarkdownImageReferences(prev, target.url).content)'
      )
    }
  })

  it('serializes profile media upload lanes before asynchronous work', () => {
    const imageUpload = functionBody(
      profileCreatePage,
      'const handleImageUpload = async',
      '// Video upload handler'
    )
    const videoUpload = functionBody(
      profileCreatePage,
      'const handleVideoUpload = async',
      '// Remove video'
    )

    for (const [body, lane] of [
      [imageUpload, 'imageUploadInFlightRef'],
      [videoUpload, 'videoUploadInFlightRef'],
    ] as const) {
      const guard = body.indexOf(`if (${lane}.current)`)
      const acquire = body.indexOf(`${lane}.current = true`)
      const asyncWork = body.indexOf('tokenRefreshCoordinator.getValidToken()')
      const release = body.indexOf(`${lane}.current = false`)

      expect(guard).toBeGreaterThanOrEqual(0)
      expect(acquire).toBeGreaterThan(guard)
      expect(asyncWork).toBeGreaterThan(acquire)
      expect(release).toBeGreaterThan(asyncWork)
      expect(body.slice(release - 80, release)).toContain('finally')
    }
  })

  it('keeps profile publish/navigation and actual inputs closed during uploads', () => {
    const submit = functionBody(profileCreatePage, 'const handleSubmit = async', '  return (')
    const authority = submit.indexOf('bindPostCreateOperation(')

    expect(submit).toContain('imageUploadInFlightRef.current')
    expect(submit).toContain('videoUploadInFlightRef.current')
    expect(authority).toBeGreaterThan(submit.indexOf('imageUploadInFlightRef.current'))
    expect(profileCreatePage).toContain('disabled={loading || uploading || videoUploading}')
    expect(profileCreatePage).toContain(
      'disabled={loading || uploading || videoUploading || !title.trim()}'
    )
    expect(profileMediaUploader).toContain('disabled={uploading}')
    expect(profileMediaUploader).toContain('aria-disabled={uploading}')
    expect(profileMediaUploader).toContain('disabled={videoUploading}')
    expect(profileMediaUploader).toContain('aria-disabled={videoUploading}')
  })

  it('serializes group media upload lanes before asynchronous token or network work', () => {
    const imageUpload = functionBody(
      groupCreatePage,
      'const handleImageUpload = useCallback',
      'const removeImage = useCallback'
    )
    const videoUpload = functionBody(
      groupCreatePage,
      'const handleVideoUpload = useCallback',
      'const removeVideo = useCallback'
    )

    for (const [body, lane] of [
      [imageUpload, 'imageUploadInFlightRef'],
      [videoUpload, 'videoUploadInFlightRef'],
    ] as const) {
      const guard = body.indexOf(`if (${lane}.current)`)
      const acquire = body.indexOf(`${lane}.current = true`)
      const asyncToken = body.indexOf('tokenRefreshCoordinator.getValidToken()')
      const release = body.indexOf(`${lane}.current = false`)

      expect(guard).toBeGreaterThanOrEqual(0)
      expect(acquire).toBeGreaterThan(guard)
      expect(asyncToken).toBeGreaterThan(acquire)
      expect(release).toBeGreaterThan(asyncToken)
      expect(body.slice(release - 80, release)).toContain('finally')
    }
  })

  it('keeps group publish and navigation closed while either upload lane is active', () => {
    const submit = functionBody(groupCreatePage, 'const handleSubmit = async', '  return (')
    const authority = submit.indexOf('bindPostCreateOperation(')

    expect(submit).toContain('imageUploadInFlightRef.current')
    expect(submit).toContain('videoUploadInFlightRef.current')
    expect(submit).toContain('uploading ||')
    expect(submit).toContain('videoUploading')
    expect(authority).toBeGreaterThan(submit.indexOf('imageUploadInFlightRef.current'))
    expect(groupCreatePage).toContain('disabled={loading || uploading || videoUploading}')
    expect(groupCreatePage).toContain(
      'disabled={loading || uploading || videoUploading || !title.trim()}'
    )
  })

  it('disables group file inputs instead of relying on visual busy styling', () => {
    expect(groupImageUploader).toContain('disabled={uploading}')
    expect(groupImageUploader).toContain('aria-disabled={uploading}')
    expect(groupImageUploader).toContain('if (uploading) event.preventDefault()')

    expect(groupVideoUploader).toContain('disabled={videoUploading}')
    expect(groupVideoUploader).toContain('aria-disabled={videoUploading}')
    expect(groupVideoUploader).toContain('if (videoUploading) event.preventDefault()')
  })
})
