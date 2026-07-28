import fs from 'node:fs'
import path from 'node:path'

describe('API tier banner mobile reflow contract', () => {
  const component = fs.readFileSync(
    path.join(process.cwd(), 'app/(app)/settings/components/ApiKeysSection.tsx'),
    'utf8'
  )
  const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')

  it('gives the banner, metadata, limit and actions stable responsive hooks', () => {
    expect(component).toContain('className="api-tier-banner"')
    expect(component).toContain('className="api-tier-banner-summary"')
    expect(component).toContain('className="api-tier-banner-meta"')
    expect(component).toContain('className="api-tier-banner-limit"')
    expect(component).toContain('className="api-tier-banner-actions"')
  })

  it('stacks the banner and keeps every upgrade action usable at 320px', () => {
    expect(css).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.api-tier-banner\s*\{[\s\S]*?flex-direction: column/
    )
    expect(css).toMatch(
      /\.api-tier-banner-actions\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/
    )
    expect(css).toMatch(
      /\.api-tier-banner-actions > button\s*\{[\s\S]*?min-height: 44px !important[\s\S]*?white-space: normal/
    )
  })

  it('gives API key rows stable hooks for long names, codes and actions', () => {
    expect(component).toContain('className="api-key-row"')
    expect(component).toContain('className="api-key-row-main"')
    expect(component).toContain('className="api-key-row-identity"')
    expect(component).toContain('className="api-key-row-name"')
    expect(component).toContain('className="api-key-row-code"')
    expect(component).toContain('className="api-key-row-metadata"')
    expect(component).toContain('className="api-key-row-actions"')
  })

  it('only offers copy for the full key shown immediately after creation', () => {
    expect(component).toContain('onClick={() => void copyKey(visibleJustCreatedKey)}')
    expect(component).not.toContain('onCopy={copyKey}')
    expect(component).not.toContain('onCopy(apiKey.key)')
  })

  it('keeps every API-key action at a mobile touch target without horizontal overflow', () => {
    expect(component).toContain('className="api-key-load-retry"')
    expect(component).toContain('className="api-created-key-secret"')
    expect(component).toContain('className="api-created-key-code"')
    expect(component).toContain('className="api-created-key-copy"')
    expect(component).toContain('className="api-created-key-dismiss"')
    expect(component).toContain('className="api-key-create-row"')
    expect(component).toContain('className="api-key-create-button"')
    expect(css).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.api-key-load-retry,[\s\S]*?\.api-created-key-copy,[\s\S]*?\.api-key-create-button\s*\{[\s\S]*?min-height: 44px !important/
    )
    expect(css).toMatch(
      /\.api-created-key-dismiss\s*\{[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/
    )
    expect(css).toMatch(/\.api-key-create-row\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
  })

  it('wraps long key content and moves the usable revoke action below it on narrow screens', () => {
    expect(css).toMatch(
      /\.api-key-row-name,[\s\S]*?\.api-key-row-code\s*\{[\s\S]*?overflow-wrap: anywhere[\s\S]*?white-space: normal/
    )
    expect(css).toMatch(/\.api-key-row-code\s*\{[\s\S]*?word-break: break-all/)
    expect(css).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.api-key-row\s*\{[\s\S]*?flex-direction: column/
    )
    expect(css).toMatch(/\.api-key-row-actions\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.api-key-row-actions > button\s*\{[\s\S]*?min-height: 44px !important/)
  })
})
