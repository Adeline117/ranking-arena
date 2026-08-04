import { parseReportEvidenceRef } from './evidence'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

type ReportContentType = 'post' | 'comment' | 'message' | 'user'
type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'misinformation' | 'fraud' | 'other'

export type ReportEvidenceUploadAcknowledgement = Readonly<{
  evidenceRef: string
  previewUrl: string
}>

export type ReportSubmissionAcknowledgement = Readonly<{
  reportId: string
  createdAt: string
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  return ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
}

function isCanonicalEvidencePreview(
  value: unknown,
  objectName: string,
  storageBaseUrl: string
): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    CONTROL_PATTERN.test(value)
  ) {
    return false
  }

  try {
    const url = new URL(value)
    const storageBase = new URL(storageBaseUrl)
    const queryKeys = [...url.searchParams.keys()]
    return (
      url.protocol === 'https:' &&
      url.origin === storageBase.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      decodeURIComponent(url.pathname) === `/storage/v1/object/sign/reports/${objectName}` &&
      queryKeys.length === 1 &&
      queryKeys[0] === 'token' &&
      Boolean(url.searchParams.get('token'))
    )
  } catch {
    return false
  }
}

export function readOwnedReportEvidenceRef(value: unknown, ownerId: string): string | null {
  if (!isRecord(value) || typeof value.evidence_ref !== 'string') return null
  return parseReportEvidenceRef(value.evidence_ref, ownerId)?.ref ?? null
}

export function readReportEvidenceUploadAcknowledgement(
  value: unknown,
  ownerId: string,
  storageBaseUrl: string
): ReportEvidenceUploadAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['evidence_ref', 'preview_url', 'url']) ||
    value.url !== value.preview_url
  ) {
    return null
  }

  const evidence =
    typeof value.evidence_ref === 'string'
      ? parseReportEvidenceRef(value.evidence_ref, ownerId)
      : null
  if (
    !evidence ||
    !isCanonicalEvidencePreview(value.preview_url, evidence.objectName, storageBaseUrl)
  ) {
    return null
  }

  return { evidenceRef: evidence.ref, previewUrl: value.preview_url }
}

export function isReportEvidenceCleanupAcknowledgement(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['deleted', 'success']) &&
    value.success === true &&
    typeof value.deleted === 'boolean'
  )
}

export function readReportSubmissionAcknowledgement(
  value: unknown,
  expected: {
    reporterId: string
    contentType: ReportContentType
    contentId: string
    reason: ReportReason
    evidenceRefs: readonly string[]
  }
): ReportSubmissionAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ['report']) ||
    !isRecord(value.data.report) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isIsoTimestamp(value.meta.timestamp)
  ) {
    return null
  }

  const report = value.data.report
  if (
    !hasExactKeys(report, [
      'content_id',
      'content_type',
      'created_at',
      'evidence_refs',
      'id',
      'reason',
      'reporter_id',
      'status',
    ]) ||
    !isCanonicalUuid(report.id) ||
    report.reporter_id !== expected.reporterId.toLowerCase() ||
    report.content_id !== expected.contentId.toLowerCase() ||
    report.content_type !== expected.contentType ||
    report.reason !== expected.reason ||
    report.status !== 'pending' ||
    !isIsoTimestamp(report.created_at) ||
    !Array.isArray(report.evidence_refs) ||
    report.evidence_refs.length !== expected.evidenceRefs.length ||
    report.evidence_refs.some(
      (ref, index) =>
        ref !== expected.evidenceRefs[index] ||
        typeof ref !== 'string' ||
        !parseReportEvidenceRef(ref, expected.reporterId)
    )
  ) {
    return null
  }

  return { reportId: report.id, createdAt: report.created_at }
}
