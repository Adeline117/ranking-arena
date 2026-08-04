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

  it('loads responsive layout rules before first paint', () => {
    const globalsImport = rootLayoutSource.indexOf("import './globals.css'")
    const responsiveImport = rootLayoutSource.indexOf("import '../public/styles/responsive.css'")

    expect(globalsImport).toBeGreaterThan(-1)
    expect(responsiveImport).toBeGreaterThan(globalsImport)
    expect(
      rootLayoutSource.match(/import ['"]\.\.\/public\/styles\/responsive\.css['"]/g)
    ).toHaveLength(1)
    expect(rootLayoutSource).not.toMatch(/href=['"]\/styles\/responsive\.css['"]/)
    expect(rootLayoutSource).not.toContain("a.media='print'")
    expect(rootLayoutSource).not.toContain("a.onload=function(){a.media='all'}")
  })

  it('keeps the recovery scrubber before every other author-owned root-layout script', () => {
    const headStart = rootLayoutSource.indexOf('<head>')
    const firstScript = rootLayoutSource.indexOf('<script', headStart)
    const recoveryBootstrap = rootLayoutSource.indexOf(
      'getAccountRecoveryBootstrapScript()',
      headStart
    )
    const firstUnrelatedScript = rootLayoutSource.indexOf('<script', firstScript + 1)

    expect(headStart).toBeGreaterThan(-1)
    expect(firstScript).toBeGreaterThan(headStart)
    expect(recoveryBootstrap).toBeGreaterThan(headStart)
    expect(recoveryBootstrap).toBeGreaterThan(firstScript)
    expect(firstUnrelatedScript).toBeGreaterThan(recoveryBootstrap)
  })
})
