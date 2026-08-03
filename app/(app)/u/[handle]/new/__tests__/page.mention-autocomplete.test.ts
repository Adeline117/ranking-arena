import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'app/(app)/u/[handle]/new/page.tsx'), 'utf8')

describe('profile post mention autocomplete', () => {
  it('uses the shared Unicode-aware picker and preserves textarea focus', () => {
    expect(source).toContain('useMentionAutocomplete()')
    expect(source).toContain('<MentionAutocomplete')
    expect(source).toContain('mentionAutocomplete.handleTextChange')
    expect(source).toContain('nextContent.length > CONTENT_MAX_LENGTH')
    expect(source).toContain('textareaRef.current?.setSelectionRange(nextCursor, nextCursor)')
  })
})
