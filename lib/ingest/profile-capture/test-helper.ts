/**
 * Test helper for source implementers declaring a profile capture contract.
 *
 * Feed it the source's recorded profile pages (url + payload, as getProfile
 * returns them) and its real parser; it runs exactly what the Tier-B worker
 * runs (parse every page, take the last block for the timeframe, staging
 * validation, buildProfileAcquisition) with a synthetic attempt identity, and
 * returns the typed outcome. `expectProfileContractAttests` additionally
 * throws unless the capture is complete and attests exactly `metrics`.
 *
 * No database, network or jest dependency: usable from any adapter test.
 */

import type { ParseCtx, ParsedProfile, ParsedStats, RankingTimeframe, RawPage } from '../core/types'
import { validateStats } from '../staging/validate'
import { buildProfileAcquisition, lastStatsBlock, type ProfileCaptureResult } from './capture'
import {
  profileCaptureContractSha256,
  type ProfileAttestableMetric,
  type ProfileCaptureContract,
} from './contract'

export const FIXTURE_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'

export interface ProfileContractFixtureInput {
  contract: ProfileCaptureContract
  timeframe: RankingTimeframe
  pages: readonly RawPage[]
  parseProfile: (payload: unknown, ctx: ParseCtx) => ParsedProfile
  exchangeTraderId?: string
  ctx?: Partial<ParseCtx>
  /** sources.meta.profile_required_fields, when the source sets it. */
  requiredFields?: Array<keyof ParsedStats>
}

export type ProfileContractFixtureResult = ProfileCaptureResult & {
  parsed: ParsedStats | null
  stored: ParsedStats | null
}

export function runProfileContractFixture(
  input: ProfileContractFixtureInput
): ProfileContractFixtureResult {
  const ctx: ParseCtx = {
    sourceSlug: input.contract.sourceSlug,
    currency: 'USDT',
    tfLabelMap: {},
    scrapedAt: '2026-01-01T00:00:00.000Z',
    meta: {},
    ...input.ctx,
  }
  const profiles = input.pages.map((page) => input.parseProfile(page.payload, ctx))
  const parsed = lastStatsBlock(profiles, input.timeframe)?.block ?? null
  const stored =
    parsed === null ? null : (validateStats([parsed], input.requiredFields ?? []).valid[0] ?? null)
  const result = buildProfileAcquisition({
    contract: input.contract,
    contractSha256: profileCaptureContractSha256(input.contract),
    attemptId: FIXTURE_ATTEMPT_ID,
    exchangeTraderId: input.exchangeTraderId ?? 'fixture-trader',
    timeframe: input.timeframe,
    pages: input.pages,
    parsed,
    stored,
  })
  return { ...result, parsed, stored }
}

export function expectProfileContractAttests(
  input: ProfileContractFixtureInput & { metrics: readonly ProfileAttestableMetric[] }
): ProfileContractFixtureResult {
  const result = runProfileContractFixture(input)
  if (result.terminalState !== 'complete') {
    throw new Error(
      `[profile-capture] ${input.contract.captureContract} ${input.timeframe}d is ` +
        `${result.terminalState}/${result.reasonCode}: ${result.detail}`
    )
  }
  const expected = [...input.metrics].sort()
  if (JSON.stringify(result.attestedMetrics) !== JSON.stringify(expected)) {
    throw new Error(
      `[profile-capture] ${input.contract.captureContract} ${input.timeframe}d attests ` +
        `[${result.attestedMetrics.join(',')}], expected [${expected.join(',')}]`
    )
  }
  return result
}
