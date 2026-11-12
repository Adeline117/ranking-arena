import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A bare `1fr` track has an `auto` minimum, so the widest code sample in the
// endpoint list sizes the whole column. On a 390px phone that pushed the
// endpoint docs to ~845px and the page container clipped them.
describe('API docs endpoint layout', () => {
  const page = readFileSync(join(process.cwd(), 'app/(app)/api-docs/page.tsx'), 'utf8')

  it('lets the single-column mobile track shrink below its content width', () => {
    expect(page).toContain('.apiEndpointsLayout{display:grid;grid-template-columns:minmax(0,1fr);')
    expect(page).not.toMatch(/\.apiEndpointsLayout\{[^}]*grid-template-columns:1fr[;}]/)
  })
})
