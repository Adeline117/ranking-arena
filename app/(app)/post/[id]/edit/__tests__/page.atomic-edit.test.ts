import { readFileSync } from 'node:fs'
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

  it('protects image-only edits with the unsaved-change guard', () => {
    expect(page).toContain('images.map((image) => image.url)')
    expect(page).toContain('Array.isArray(originalPost.images)')
    expect(page).toContain('!sameStringList(')
  })
})
