import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { renderContentWithLinks } from '@/lib/utils/content'

const page = readFileSync(resolve(process.cwd(), 'app/(app)/post/[id]/edit/page.tsx'), 'utf8')

describe('full post editor atomic write path', () => {
  it('loads a database-owned revision and never writes posts directly', () => {
    expect(page).toContain('updated_at, content_version')
    expect(page).not.toMatch(/\.from\(['"]posts['"]\)[\s\S]*?\.update\(/)
    expect(page).toContain('expected_version: Number(expectedVersion)')
    expect(page).toContain('readPostEditApiAcknowledgement(responseBody, postId)')
  })

  it('binds save completion to the same authenticated viewer and exact images', () => {
    expect(page).toContain('jwtSubject(saveToken) !== capturedUserId')
    expect(page).toContain('!isViewerScopeCurrent(capturedScope)')
    expect(page).toContain('acknowledgement.author_id !== capturedUserId')
    expect(page).toContain('sameStringList(acknowledgement.images ?? [], submittedImages)')
  })

  it('does not leave unauthenticated or failed identity resolution on an infinite skeleton', () => {
    expect(page).toContain('router.replace(`/login?redirect=${encodeURIComponent(')
    expect(page).toContain("logger.error('Error resolving editor identity:'")
    expect(page).toContain('setLoading(false)')
    expect(page).not.toContain('setEmail(')
    expect(page).not.toContain('as SupabaseClient')
  })

  it('protects image-only edits with the unsaved-change guard', () => {
    expect(page).toContain('images.map((image) => image.url)')
    expect(page).toContain('Array.isArray(originalPost.images)')
    expect(page).toContain('!sameStringList(')
  })

  it('removes a tray image from both the submitted list and Markdown content', () => {
    const start = page.indexOf('const removeImage = (index: number) =>')
    const end = page.indexOf('// 插入图片到内容', start)
    const removal = page.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(removal).toContain('const target = images[index]')
    expect(removal).toContain('if (!target) return')
    expect(removal).toContain(
      'setImages((prev) => prev.filter((image) => image.url !== target.url))'
    )
    expect(removal).toContain(
      'setContent((prev) => removeMarkdownImageReferences(prev, target.url).content)'
    )
  })

  it('accepts image uploads only through the owner-bound acknowledgement parser', () => {
    expect(page).toContain('readPostImageUploadAcknowledgement(')
    expect(page).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''")
    expect(page).toContain('readPostMediaUploadError(responseBody)')
  })

  it('serializes image uploads and closes save/navigation until the lane settles', () => {
    const uploadStart = page.indexOf('const handleImageUpload = async')
    const uploadEnd = page.indexOf('// 移除图片', uploadStart)
    const upload = page.slice(uploadStart, uploadEnd)
    const guard = upload.indexOf('if (imageUploadInFlightRef.current)')
    const acquire = upload.indexOf('imageUploadInFlightRef.current = true')
    const token = upload.indexOf('tokenRefreshCoordinator.getValidToken()')
    const release = upload.indexOf('imageUploadInFlightRef.current = false')
    const submitStart = page.indexOf('const handleSubmit = async')
    const submitEnd = page.indexOf('if (loading)', submitStart)
    const submit = page.slice(submitStart, submitEnd)

    expect(uploadStart).toBeGreaterThanOrEqual(0)
    expect(uploadEnd).toBeGreaterThan(uploadStart)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(acquire).toBeGreaterThan(guard)
    expect(token).toBeGreaterThan(acquire)
    expect(release).toBeGreaterThan(token)
    expect(upload.slice(release - 80, release)).toContain('finally')
    expect(submit).toContain('imageUploadInFlightRef.current')
    expect(submit.indexOf('imageUploadInFlightRef.current')).toBeLessThan(
      submit.indexOf('submitRef.current = true')
    )
    expect(page).toContain('onChange={handleImageUpload}\n              disabled={uploading}')
    expect(page).toContain('disabled={saving || uploading}')
    expect(page).toContain('disabled={saving || uploading || !title.trim()}')
  })

  it('names and touch-sizes edit tray actions without a generic close label', () => {
    const trayStart = page.indexOf('{images.map((img, index) =>')
    const trayEnd = page.indexOf('{images.length < 9 &&', trayStart)
    const tray = page.slice(trayStart, trayEnd)

    expect(trayStart).toBeGreaterThanOrEqual(0)
    expect(trayEnd).toBeGreaterThan(trayStart)
    expect(tray).toContain("aria-label={inContent ? t('reinsertAtCursor') : t('insertAtCursor')}")
    expect(tray).toContain("aria-label={t('deleteImage')}")
    expect(tray).not.toContain('aria-label="Close"')
    expect(tray.match(/width: tokens\.touchTarget\.min/g)).toHaveLength(2)
    expect(tray.match(/height: tokens\.touchTarget\.min/g)).toHaveLength(2)
  })

  it('keeps preview links consistent and rejects unsafe markdown image targets', () => {
    expect(page).toContain('linkifyTagsAndMentions(part')
    expect(page).toContain('for (const token of findMarkdownImageTokens(text))')
    expect(page).toContain('for (const token of findRawContentUrlTokens(value))')
    expect(page).toContain('...findMarkdownVideoTokens(text).map((token) => ({')
    expect(page).toContain('normalizeHttpUrl(token.url) ? parseVideoUrl(token.url) : null')
    expect(page).toContain("if (part.type === 'video')")
    expect(page).toContain('renderContentWithLinks(part.content)')
    expect(page).toContain('const normalizedUrl = normalizeHttpUrl(token.url)')
    expect(page).toContain('imageIndex: normalizedUrl ? imgIdx++ : null')
    expect(page).toContain('if (match.start < currentIndex) continue')
    expect(page).toContain("window.open(part.url, '_blank', 'noopener,noreferrer')")
    expect(page).toContain('moveMarkdownImage(content, url, direction)')
    expect(page).toContain('removeMarkdownImage(content, url)')
    expect(page).not.toContain('__PLACEHOLDER_1__')
  })

  it('offers the shared keyboard-safe mention picker while editing', () => {
    expect(page).toContain('useMentionAutocomplete()')
    expect(page).toContain('mentionAutocomplete.handleTextChange(')
    expect(page).toContain('<MentionAutocomplete')
    expect(page).toContain('textareaRef.current?.setSelectionRange(nextCursor, nextCursor)')
  })

  it('has no dormant duplicate editor that can restore direct database writes', () => {
    for (const relativePath of [
      'app/(app)/post/[id]/edit/_hooks/useEditPost.ts',
      'app/(app)/post/[id]/edit/_components/ContentPreview.tsx',
      'app/(app)/post/[id]/edit/_components/EditorForm.tsx',
      'app/(app)/post/[id]/edit/_components/ImageUploadSection.tsx',
    ]) {
      expect(existsSync(resolve(process.cwd(), relativePath))).toBe(false)
    }
  })
})

describe('post edit media preview', () => {
  const renderPreview = (content: string) =>
    render(createElement('div', null, renderContentWithLinks(content))).container

  it('renders a direct-video marker as an actual video element', () => {
    const url = 'https://cdn.example/video.mp4'
    const container = renderPreview(`[video](${url})`)

    expect(container.querySelector('video')).toHaveAttribute('src', url)
    expect(container.querySelector('video')).toHaveAttribute('controls')
    expect(container.querySelector('video')).toHaveAttribute('preload', 'metadata')
  })

  it.each([
    ['動画', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['동영상', 'https://www.bilibili.com/video/BV1xx411c7mD'],
  ])('renders the persisted %s marker through the shared iframe renderer', (label, url) => {
    expect(renderPreview(`[${label}](${url})`).querySelector('iframe')).not.toBeNull()
  })

  it.each([
    '[video](javascript:evil.mp4)',
    '[video](/relative/video.mp4)',
    '[video](https://cdn.example/video.txt)',
  ])('preserves an invalid or unsupported marker verbatim: %s', (marker) => {
    const container = renderPreview(marker)

    expect(container.querySelector('video, iframe')).toBeNull()
    expect(container.textContent).toBe(marker)
  })

  it.each([
    '[video](![image](https://cdn.example/image.png))',
    '![image]([video](https://cdn.example/video.mp4))',
  ])('does not render a nested media token outside its outer range: %s', (content) => {
    const container = renderPreview(content)

    expect(container.querySelector('img, video, iframe')).toBeNull()
    expect(container.textContent).toBe(content)
  })
})
