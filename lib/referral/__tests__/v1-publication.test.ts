/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isV1ReferralProgramPublished,
  V1_REFERRAL_PROGRAM_NO_STORE_HEADERS,
  V1_REFERRAL_PROGRAM_NOT_PUBLISHED_CODE,
  V1_REFERRAL_PROGRAM_PUBLISHED,
  V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY,
} from '../v1-publication'

const root = process.cwd()

describe('V1 referral-program publication boundary', () => {
  it('is an immutable checked-in false hold with a browser-safe contract', () => {
    const source = readFileSync(join(root, 'lib/referral/v1-publication.ts'), 'utf8')
    const originalPublicationSetting = process.env.V1_REFERRAL_PROGRAM_PUBLISHED

    process.env.V1_REFERRAL_PROGRAM_PUBLISHED = 'true'

    try {
      expect(V1_REFERRAL_PROGRAM_PUBLISHED).toBe(false)
      expect(isV1ReferralProgramPublished()).toBe(false)
      expect(V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY).toEqual({
        error: 'Referral program is temporarily unavailable during V1 verification.',
        code: V1_REFERRAL_PROGRAM_NOT_PUBLISHED_CODE,
      })
      expect(V1_REFERRAL_PROGRAM_NO_STORE_HEADERS).toEqual({
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      })
      expect(source).not.toMatch(/process\.env|next\/server|node:/)
    } finally {
      if (originalPublicationSetting === undefined) {
        delete process.env.V1_REFERRAL_PROGRAM_PUBLISHED
      } else {
        process.env.V1_REFERRAL_PROGRAM_PUBLISHED = originalPublicationSetting
      }
    }
  })

  it('removes pre-hydration capture and never reuses the legacy storage namespace', () => {
    const layout = readFileSync(join(root, 'app/layout.tsx'), 'utf8')
    const pending = readFileSync(join(root, 'lib/referral/pending.ts'), 'utf8')

    expect(layout).not.toContain('arena_pending_ref')
    expect(layout).not.toContain("URLSearchParams(location.search).get('ref')")
    expect(pending).not.toContain("'arena_pending_ref'")
    expect(pending).toContain("'arena_pending_referral_v1'")
  })
})
