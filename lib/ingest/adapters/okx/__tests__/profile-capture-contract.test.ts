/**
 * okx_futures / okx_spot declare NO Tier-B profile capture contract, and this
 * file pins why, over verbatim public responses (unauthenticated GET, no
 * cookies, captured 2026-11-21T07:45Z; one SWAP and one SPOT lead trader,
 * every endpoint for 7/30/90).
 *
 * A contract may only attest a value the exchange reports for the requested
 * window. No public OKX surface reports a per-window maximum drawdown:
 *   - official public-stats (what getProfile fetches): no drawdown field;
 *   - web trader/trade-data (the current detail page, both products): none;
 *   - web trade-data (SWAP): none;
 *   - web spot/trade-data: tails `maxRetreat`, the SAME value for
 *     latestNum=7/30/90, so it is not the requested window's drawdown (the
 *     Blofin precedent: values identical across periods are not period
 *     evidence);
 *   - web max-drawdown?uniqueName: day / week / history figures of the public
 *     account profile, with no product and no 7/30/90 window parameter.
 * The per-window win rate is real (public-stats winRatio) but the board entry
 * already carries it, so a win-rate-only contract would attest nothing new.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParseCtx } from '../../../core/types'
import { getProfileCaptureContract } from '../../../profile-capture/contract'
import { parseOkxProfile } from '../parsers'

type Dict = Record<string, unknown>
interface Recorded {
  uniqueCode: string
  responses: Record<string, { code: string; data: Dict[] }>
}
const probe = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'profile-drawdown-probe.json'), 'utf8')
) as { swap: Recorded; spot: Recorded }

const V5 = '/api/v5/copytrading'
const WEB = '/priapi/v5/ecotrade/public'
const WINDOWS = [
  { timeframe: 7, lastDays: 1 },
  { timeframe: 30, lastDays: 2 },
  { timeframe: 90, lastDays: 3 },
] as const
const DRAWDOWN_KEY = /drawdown|retreat|mdd/i

function body(recorded: Recorded, path: string): Dict {
  const response = recorded.responses[path]
  if (!response || response.code !== '0' || response.data.length !== 1) {
    throw new Error(`fixture has no single-row answer for ${path}`)
  }
  return response.data[0]
}

/** Web stat cards: every `{functionId, value}` item of every section. */
function cards(row: Dict): Map<string, string> {
  const out = new Map<string, string>()
  for (const section of Object.values(row)) {
    if (!Array.isArray(section)) continue
    for (const item of section as Dict[]) out.set(String(item.functionId), String(item.value))
  }
  return out
}

const ctx: ParseCtx = {
  sourceSlug: 'okx_spot',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-11-21T07:45:11.000Z',
  meta: {},
}

describe('okx profile capture contract', () => {
  it('is not declared for either OKX CEX source', () => {
    expect(getProfileCaptureContract('okx_futures')).toBeNull()
    expect(getProfileCaptureContract('okx_spot')).toBeNull()
  })

  it.each([
    ['SWAP', probe.swap],
    ['SPOT', probe.spot],
  ] as const)(
    '%s public-stats reports a per-window win ratio and no drawdown',
    (instType, recorded) => {
      const winRatios = WINDOWS.map(({ timeframe, lastDays }) => {
        const stats = body(
          recorded,
          `${V5}/public-stats?instType=${instType}&uniqueCode=${recorded.uniqueCode}&lastDays=${lastDays}`
        )
        expect(Object.keys(stats).filter((key) => DRAWDOWN_KEY.test(key))).toEqual([])
        // The window is real: profit + loss days sum to the requested window.
        expect(Number(stats.profitDays) + Number(stats.lossDays)).toBe(timeframe)

        const parsed = parseOkxProfile(
          { timeframe, stats: { data: [stats] }, pnl: { data: [] }, preference: { data: [] } },
          ctx
        ).stats[0]
        expect(parsed.mdd).toBeNull()
        expect(parsed.winRate).toBeCloseTo(Number(stats.winRatio) * 100, 9)
        return stats.winRatio
      })
      expect(new Set(winRatios).size).toBe(WINDOWS.length)
    }
  )

  it('the current web detail page (trader/trade-data) shows no drawdown card', () => {
    for (const [bizType, recorded] of [
      ['SWAP', probe.swap],
      ['SPOT', probe.spot],
    ] as const) {
      for (const { timeframe } of WINDOWS) {
        const shown = cards(
          body(
            recorded,
            `${WEB}/trader/trade-data?uniqueName=${recorded.uniqueCode}&latestNum=${timeframe}&bizType=${bizType}`
          )
        )
        expect(shown.has('winRatio')).toBe(true)
        expect([...shown.keys()].filter((key) => DRAWDOWN_KEY.test(key))).toEqual([])
      }
    }
  })

  it('SWAP trade-data carries no drawdown for any window', () => {
    for (const { timeframe } of WINDOWS) {
      const shown = cards(
        body(
          probe.swap,
          `${WEB}/trade-data?uniqueName=${probe.swap.uniqueCode}&latestNum=${timeframe}`
        )
      )
      expect([...shown.keys()].filter((key) => DRAWDOWN_KEY.test(key))).toEqual([])
    }
  })

  it('SPOT maxRetreat does not follow the requested window', () => {
    const perWindow = WINDOWS.map(({ timeframe }) =>
      cards(
        body(
          probe.spot,
          `${WEB}/spot/trade-data?uniqueName=${probe.spot.uniqueCode}&latestNum=${timeframe}`
        )
      )
    )
    // Window-bound cards differ per window...
    expect(new Set(perWindow.map((shown) => shown.get('winRatio'))).size).toBe(3)
    expect(new Set(perWindow.map((shown) => shown.get('profitDays'))).size).toBe(3)
    // ...the drawdown card is one value whatever window is asked for.
    expect(perWindow.map((shown) => shown.get('maxRetreat'))).toEqual([
      '-0.2809',
      '-0.2809',
      '-0.2809',
    ])
  })

  it('max-drawdown is keyed by trader only: day / week / history, not 7/30/90', () => {
    for (const recorded of [probe.swap, probe.spot]) {
      const row = body(recorded, `${WEB}/max-drawdown?uniqueName=${recorded.uniqueCode}`)
      expect(Object.keys(row).sort()).toEqual([
        'dayMaxDrawdown',
        'historyMaxDrawdown',
        'weekMaxDrawdown',
      ])
    }
  })
})
