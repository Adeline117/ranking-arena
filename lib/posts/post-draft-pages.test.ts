import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PROFILE_PAGE = 'app/(app)/u/[handle]/new/page.tsx'
const GROUP_PAGE = 'app/(app)/groups/[id]/new/page.tsx'
const COMPLETE_COMMON_FIELDS = [
  'title',
  'content',
  'images',
  'videos',
  'pollEnabled',
  'pollOptions',
  'pollType',
  'pollDuration',
  'isSensitive',
  'contentWarning',
] as const

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

function blockBetween(page: string, start: string, end: string): string {
  const startIndex = page.indexOf(start)
  const endIndex = page.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return page.slice(startIndex, endIndex)
}

describe.each([
  [PROFILE_PAGE, "destination: { type: 'profile', handle }", true],
  [GROUP_PAGE, "destination: { type: 'group', groupId }", false],
] as const)('%s owner-scoped draft integration', (relativePath, destination, isProfile) => {
  const page = source(relativePath)

  it('waits for a resolved owner and binds the exact destination', () => {
    const scopeBlock = blockBetween(page, 'const draftScope = useMemo', 'const draftData = useMemo')
    expect(scopeBlock).toContain('userId')
    expect(scopeBlock).toContain('ownerId: userId')
    expect(scopeBlock).toContain(destination)

    expect(page).toMatch(/if \(!draftScope \|\| !draftScopeKey\)/)
    expect(page).toContain('hydratedDraftScopeKey !== draftScopeKey')
    expect(page).toContain('readPostDraft(localStorage, draftScope)')
    expect(page).toContain('savePostDraft(localStorage, draftScope, draftData)')
    expect(page).toContain('removePostDraft(localStorage, draftScope)')
  })

  it('persists and restores every editable field', () => {
    const dataBlock = blockBetween(page, 'const draftData = useMemo', 'const hasUnsavedDraft')
    for (const field of COMPLETE_COMMON_FIELDS) {
      expect(dataBlock).toMatch(new RegExp(`\\b${field}\\b`))
      expect(page).toContain(`set${field[0].toUpperCase()}${field.slice(1)}(draft.${field})`)
    }
    if (isProfile) {
      expect(dataBlock).toMatch(/\bvisibility:/)
      expect(page).toContain('setVisibility(draft.visibility)')
    } else {
      expect(dataBlock).not.toMatch(/\bvisibility:/)
    }
    expect(dataBlock).not.toMatch(/token|authorization|credential/i)
  })

  it('guards non-text state and removes only the scoped draft when emptied or published', () => {
    expect(page).toContain('useUnsavedChangesGuard(hasUnsavedDraft && !loading)')
    expect(page).toMatch(/else \{\s*removePostDraft\(localStorage, draftScope\)[\s\S]*?\}/)

    const publishIndex = page.indexOf('await publishPostAtomic(')
    expect(publishIndex).toBeGreaterThanOrEqual(0)
    expect(page.slice(publishIndex)).toMatch(
      /publishOperationRef\.current = null[\s\S]*clearDraft\(\)/
    )
  })

  it('never reaches legacy ownerless draft keys or parses storage directly', () => {
    expect(page).not.toMatch(/post_draft_|group_post_draft_|DRAFT_KEY_PREFIX/)
    expect(page).not.toMatch(/localStorage\.(?:getItem|removeItem)\(/)
    expect(page).not.toMatch(/JSON\.parse\(draft/)
    if (isProfile) expect(page).not.toMatch(/localStorage\.setItem\(/)
  })
})
