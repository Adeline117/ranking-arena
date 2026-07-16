import type { SupabaseClient } from '@supabase/supabase-js'
import { parseReportEvidenceRef, signReportEvidenceRefs } from '../evidence'

const REPORTER_ID = '11111111-1111-4111-8111-111111111111'
const FILE_NAME = '0123456789abcdef.webp'
const REF = `reports/${REPORTER_ID}/${FILE_NAME}`

function storageClient(methods: Record<string, jest.Mock>): SupabaseClient {
  return {
    storage: {
      from: jest.fn(() => methods),
    },
  } as unknown as SupabaseClient
}

describe('private report evidence helpers', () => {
  it('accepts only canonical stable refs in the expected reporter folder', () => {
    expect(parseReportEvidenceRef(REF, REPORTER_ID)).toMatchObject({
      reporterId: REPORTER_ID,
      objectName: `${REPORTER_ID}/${FILE_NAME}`,
    })
    expect(parseReportEvidenceRef('https://evidence.example/test.webp')).toBeNull()
    expect(parseReportEvidenceRef(`reports/${REPORTER_ID}/../test.webp`)).toBeNull()
    expect(parseReportEvidenceRef(REF, '22222222-2222-4222-8222-222222222222')).toBeNull()
  })

  it('fails signing when storage does not return the exact requested path', async () => {
    const createSignedUrls = jest.fn().mockResolvedValue({
      data: [{ path: 'different/path.webp', signedUrl: 'https://signed.test/value' }],
      error: null,
    })
    const client = storageClient({ createSignedUrls })

    await expect(signReportEvidenceRefs(client, [REF], REPORTER_ID)).rejects.toThrow(
      'Failed to sign report evidence'
    )
  })
})
