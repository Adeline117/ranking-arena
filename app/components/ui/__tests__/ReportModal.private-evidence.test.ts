import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'app/components/ui/ReportModal.tsx'), 'utf8')
const adminSource = readFileSync(
  join(process.cwd(), 'app/(app)/admin/components/ReportsTab.tsx'),
  'utf8'
)

describe('ReportModal private evidence contract', () => {
  it('separates short-lived previews from stable submitted references', () => {
    expect(source).toContain('previewUrl: string')
    expect(source).toContain('evidenceRef: string')
    expect(source).toContain('images: images.map((image) => image.evidenceRef)')
    expect(source).toContain('src={image.previewUrl}')
    expect(source).toContain('payload.preview_url')
    expect(source).toContain('payload.evidence_ref')
  })

  it('never creates or submits browser-resident base64 evidence', () => {
    expect(source).not.toContain('FileReader')
    expect(source).not.toContain('readAsDataURL')
    expect(source).not.toContain('data:image')
    expect(source).not.toContain('payload.url as string')
  })

  it('does not proxy or leak signed previews and cleans up abandoned refs', () => {
    expect(source).toContain('unoptimized')
    expect(source).toContain('referrerPolicy="no-referrer"')
    expect(source).toContain("method: 'DELETE'")
    expect(source).toContain('cleanupEvidence(removed.evidenceRef)')
    expect(source).toContain('pendingEvidence.map((image) => cleanupEvidence(image.evidenceRef))')
    expect(adminSource.match(/referrerPolicy="no-referrer"/g)).toHaveLength(2)
  })
})
