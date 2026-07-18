import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rootLayoutSource = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8')

describe('RootLayout DOM ownership', () => {
  it('leaves Next.js noindex metadata in place for React to hydrate', () => {
    expect(rootLayoutSource).not.toContain(
      'document.querySelectorAll("meta[name=robots][content=noindex]")'
    )
    expect(rootLayoutSource).not.toMatch(
      /MutationObserver[\s\S]*name=["']robots["'][\s\S]*content=["']noindex["']/
    )
  })

  it('does not replace native DOM mutation methods globally', () => {
    expect(rootLayoutSource).not.toContain('Node.prototype.insertBefore=')
    expect(rootLayoutSource).not.toContain('Node.prototype.removeChild=')
  })
})
