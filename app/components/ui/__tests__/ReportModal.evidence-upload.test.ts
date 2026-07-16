import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('ReportModal evidence upload contract', () => {
  const source = readFileSync(join(process.cwd(), 'app/components/ui/ReportModal.tsx'), 'utf8')

  it('uses the authenticated upload service without persisting data URLs', () => {
    expect(source).toContain("fetch('/api/upload'")
    expect(source).toMatch(/Authorization:[\s\S]*getCsrfHeaders\(\)/)
    expect(source).toContain('2 * 1024 * 1024')
    expect(source).toContain("evidenceUrl.protocol !== 'https:'")
    expect(source).toContain("t('uploadFailedRetry')")
    expect(source).not.toContain('new FileReader')
    expect(source).not.toContain('readAsDataURL')
  })
})
