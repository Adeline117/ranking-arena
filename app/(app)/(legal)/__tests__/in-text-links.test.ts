import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Links inside legal body copy must not rely on colour alone (axe
// link-in-text-block): the accent was 1.52:1 against the paragraph text.
describe.each(['terms', 'privacy'])('%s in-text links', (page) => {
  const source = readFileSync(join(process.cwd(), `app/(app)/(legal)/${page}/page.tsx`), 'utf8')

  it('underlines every link placed inside body copy', () => {
    expect(source).toContain("textDecoration: 'underline'")
    const inText =
      source.match(/href=\{PROFILE_HREF\}\s+className=\{anchorClass\}\s+style=\{(\w+)\}/g) ?? []
    expect(inText).toHaveLength(2)
    for (const link of inText) expect(link).toContain('style={inTextLinkStyle}')
  })
})
