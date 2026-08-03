import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

  it('accepts image uploads only through the owner-bound acknowledgement parser', () => {
    expect(page).toContain('readPostImageUploadAcknowledgement(')
    expect(page).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''")
    expect(page).toContain('readPostMediaUploadError(responseBody)')
  })

  it('keeps preview links consistent and rejects unsafe markdown image targets', () => {
    expect(page).toContain('linkifyTagsAndMentions(part')
    expect(page).toContain('const normalizedUrl = normalizeHttpUrl(match[2])')
    expect(page).toContain('if (!normalizedUrl) continue')
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
