import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('ReportModal evidence upload contract', () => {
  const source = readFileSync(join(process.cwd(), 'app/components/ui/ReportModal.tsx'), 'utf8')
  const contractSource = readFileSync(join(process.cwd(), 'lib/reports/client-contract.ts'), 'utf8')

  it('uses the authenticated upload service without persisting data URLs', () => {
    expect(source).toContain("fetch('/api/upload'")
    expect(source).toMatch(/Authorization:[\s\S]*getCsrfHeaders\(\)/)
    expect(source).toContain('2 * 1024 * 1024')
    expect(source).toContain('readReportEvidenceUploadAcknowledgement(')
    expect(contractSource).toContain("url.protocol === 'https:'")
    expect(contractSource).toContain('url.origin === storageBase.origin')
    expect(contractSource).toContain('/storage/v1/object/sign/reports/')
    expect(source).toContain("t('uploadFailedRetry')")
    expect(source).not.toContain('new FileReader')
    expect(source).not.toContain('readAsDataURL')
  })
})
