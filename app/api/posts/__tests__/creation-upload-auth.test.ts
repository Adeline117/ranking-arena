import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const profileCreatePage = readFileSync(resolve(root, 'app/(app)/u/[handle]/new/page.tsx'), 'utf8')
const groupCreatePage = readFileSync(resolve(root, 'app/(app)/groups/[id]/new/page.tsx'), 'utf8')

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
})
