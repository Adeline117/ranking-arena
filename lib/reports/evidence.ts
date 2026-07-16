export const REPORT_EVIDENCE_BUCKET = 'reports'
export const REPORT_EVIDENCE_SIGNED_URL_TTL_SECONDS = 5 * 60

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const REPORT_EVIDENCE_REF_PATTERN = new RegExp(
  `^${REPORT_EVIDENCE_BUCKET}/(${UUID_SOURCE})/([0-9a-f]{16}\\.(?:jpg|png|gif|webp|avif))$`
)

export interface ParsedReportEvidenceRef {
  ref: string
  reporterId: string
  objectName: string
  fileName: string
}

export function parseReportEvidenceRef(
  ref: string,
  expectedReporterId?: string
): ParsedReportEvidenceRef | null {
  const match = REPORT_EVIDENCE_REF_PATTERN.exec(ref)
  if (!match) return null

  const reporterId = match[1]
  if (expectedReporterId && reporterId !== expectedReporterId.toLowerCase()) return null

  return {
    ref,
    reporterId,
    objectName: `${reporterId}/${match[2]}`,
    fileName: match[2],
  }
}

/** Sign private evidence for an already-authorized administrator. */
export async function signReportEvidenceRefs(
  supabase: SupabaseClient,
  refs: string[],
  expectedReporterId?: string
): Promise<string[]> {
  const parsed = refs.map((ref) => parseReportEvidenceRef(ref, expectedReporterId))
  if (parsed.some((entry) => entry === null)) {
    throw new Error('Invalid stored report evidence reference')
  }

  if (parsed.length === 0) return []

  const objectNames = (parsed as ParsedReportEvidenceRef[]).map((entry) => entry.objectName)
  const { data, error } = await supabase.storage
    .from(REPORT_EVIDENCE_BUCKET)
    .createSignedUrls(objectNames, REPORT_EVIDENCE_SIGNED_URL_TTL_SECONDS)

  if (error || !data || data.length !== objectNames.length) {
    throw new Error('Failed to sign report evidence')
  }

  return data.map((entry, index) => {
    if (entry.error || entry.path !== objectNames[index] || !entry.signedUrl) {
      throw new Error('Failed to sign report evidence')
    }
    return entry.signedUrl
  })
}
import type { SupabaseClient } from '@supabase/supabase-js'
