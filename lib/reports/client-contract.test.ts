import {
  isReportEvidenceCleanupAcknowledgement,
  readOwnedReportEvidenceRef,
  readReportEvidenceUploadAcknowledgement,
  readReportSubmissionAcknowledgement,
} from './client-contract'

const reporterId = '11111111-1111-4111-8111-111111111111'
const contentId = '22222222-2222-4222-8222-222222222222'
const reportId = '44444444-4444-4444-8444-444444444444'
const evidenceRef = `reports/${reporterId}/0123456789abcdef.png`
const objectName = `${reporterId}/0123456789abcdef.png`
const storageBaseUrl = 'https://project.supabase.co'
const previewUrl = `${storageBaseUrl}/storage/v1/object/sign/reports/${objectName}?token=signed-token`
const createdAt = '2026-08-03T12:00:00.000Z'

describe('report client contracts', () => {
  it('binds an exact private evidence response to owner, object and storage origin', () => {
    const value = { url: previewUrl, preview_url: previewUrl, evidence_ref: evidenceRef }
    expect(readReportEvidenceUploadAcknowledgement(value, reporterId, storageBaseUrl)).toEqual({
      previewUrl,
      evidenceRef,
    })
    expect(readOwnedReportEvidenceRef(value, reporterId)).toBe(evidenceRef)

    expect(
      readReportEvidenceUploadAcknowledgement({ ...value, extra: true }, reporterId, storageBaseUrl)
    ).toBeNull()
    expect(
      readReportEvidenceUploadAcknowledgement(
        { ...value, preview_url: 'https://evil.example/evidence.png' },
        reporterId,
        storageBaseUrl
      )
    ).toBeNull()
    expect(readReportEvidenceUploadAcknowledgement(value, contentId, storageBaseUrl)).toBeNull()
    expect(
      readReportEvidenceUploadAcknowledgement(
        { ...value, preview_url: `${previewUrl}&download=1`, url: `${previewUrl}&download=1` },
        reporterId,
        storageBaseUrl
      )
    ).toBeNull()
  })

  it('accepts only an exact identity-bound report receipt', () => {
    const value = {
      success: true,
      data: {
        report: {
          id: reportId,
          reporter_id: reporterId,
          content_type: 'post',
          content_id: contentId,
          reason: 'spam',
          status: 'pending',
          created_at: createdAt,
          evidence_refs: [evidenceRef],
        },
      },
      meta: { timestamp: createdAt },
    }
    const expected = {
      reporterId,
      contentType: 'post' as const,
      contentId,
      reason: 'spam' as const,
      evidenceRefs: [evidenceRef],
    }
    expect(readReportSubmissionAcknowledgement(value, expected)).toEqual({
      reportId,
      createdAt,
    })
    const postgresTimestamp = '2026-08-03T12:00:00+00:00'
    expect(
      readReportSubmissionAcknowledgement(
        {
          ...value,
          data: {
            report: { ...value.data.report, created_at: postgresTimestamp },
          },
        },
        expected
      )
    ).toEqual({ reportId, createdAt: postgresTimestamp })
    expect(readReportSubmissionAcknowledgement({ ...value, extra: true }, expected)).toBeNull()
    expect(
      readReportSubmissionAcknowledgement(
        {
          ...value,
          data: { report: { ...value.data.report, reporter_id: contentId } },
        },
        expected
      )
    ).toBeNull()
    expect(
      readReportSubmissionAcknowledgement(
        {
          ...value,
          data: { report: { ...value.data.report, content_id: reporterId } },
        },
        expected
      )
    ).toBeNull()
    expect(
      readReportSubmissionAcknowledgement(
        {
          ...value,
          data: { report: { ...value.data.report, evidence_refs: [] } },
        },
        expected
      )
    ).toBeNull()
  })

  it('requires an exact cleanup acknowledgement', () => {
    expect(isReportEvidenceCleanupAcknowledgement({ success: true, deleted: true })).toBe(true)
    expect(isReportEvidenceCleanupAcknowledgement({ success: true, deleted: false })).toBe(true)
    expect(
      isReportEvidenceCleanupAcknowledgement({ success: true, deleted: true, extra: true })
    ).toBe(false)
  })
})
