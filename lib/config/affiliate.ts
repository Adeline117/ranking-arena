/**
 * Affiliate / referral routing config (A3 — highest revenue lever, zero
 * execution build).
 *
 * Arena stays a neutral third-party ranking site: we do NOT build matching or
 * execution. We simply route a trader-page visitor to the SAME exchange the
 * trader is on, carrying Arena's affiliate referral so the exchange rev-shares
 * (typically 20-60%). The copy-trade deep-links themselves already exist for
 * ~25 exchanges (lib/utils/copy-trade.ts); this config adds the "open account /
 * register with Arena's code" referral badge next to them.
 *
 * ── Owner: this is the ONE place to add real partnerships. ──
 * As each exchange affiliate deal is signed, paste its public referral
 * registration URL + code below (uncomment / add the entry). Only exchanges
 * present here render a referral badge; every other exchange falls through to
 * the plain copy-trade link with no badge (no fake codes ever ship). Client
 * component reads this at build → adding an entry needs a redeploy (affiliate
 * deals are infrequent, so a static config beats NEXT_PUBLIC env indirection).
 */

export interface AffiliateReferral {
  /** Full affiliate registration/referral URL (the exchange partnership link). */
  url: string
  /** Human-readable invite code shown on the badge chip. */
  code: string
  /** Brand accent for the badge chip. */
  color: string
}

/**
 * Keyed by canonical exchange (prefix-matched, so `binance_futures`,
 * `binance_spot`, … all resolve to `binance`). Add real entries as deals sign.
 */
const AFFILIATE_REFERRALS: Record<string, AffiliateReferral> = {
  // Pre-existing (migrated from ExchangeLinksBar's inline config). Replace the
  // ref code with the real Arena affiliate code when the Binance deal is live.
  binance: {
    url: 'https://www.binance.com/en/register?ref=ARENA',
    code: 'ARENA',
    color: '#F0B90B',
  },
  // ── Add as signed (URLs/codes are owner-supplied partnership data): ──
  // bybit:  { url: 'https://www.bybit.com/invite?ref=XXXXXX',        code: 'XXXXXX', color: '#F7A600' },
  // bitget: { url: 'https://partner.bitget.com/bg/XXXXXX',           code: 'XXXXXX', color: '#00D4AA' },
  // okx:    { url: 'https://www.okx.com/join/XXXXXX',                code: 'XXXXXX', color: '#FFFFFF' },
  // mexc:   { url: 'https://www.mexc.com/register?inviteCode=XXXXXX', code: 'XXXXXX', color: '#00B897' },
  // gateio: { url: 'https://www.gate.io/signup/XXXXXX',              code: 'XXXXXX', color: '#2354E6' },
  // kucoin: { url: 'https://www.kucoin.com/r/rf/XXXXXX',             code: 'XXXXXX', color: '#23AF91' },
  // htx:    { url: 'https://www.htx.com/invite/en-us/1f?invite_code=XXXX', code: 'XXXX', color: '#1F72E7' },
  // bingx:  { url: 'https://bingx.com/invite/XXXXXX',                code: 'XXXXXX', color: '#2954FE' },
  // blofin: { url: 'https://blofin.com/register?referral_code=XXXX', code: 'XXXX',   color: '#3B82F6' },
}

/**
 * Prefix → canonical key. Order-independent; first matching prefix wins.
 * Keep aligned with the copy-trade source slugs in lib/utils/copy-trade.ts.
 */
const PREFIX_TO_KEY: Array<[string, string]> = [
  ['binance', 'binance'],
  ['bybit', 'bybit'],
  ['bitget', 'bitget'],
  ['okx', 'okx'],
  ['mexc', 'mexc'],
  ['gateio', 'gateio'],
  ['gate', 'gateio'],
  ['kucoin', 'kucoin'],
  ['htx', 'htx'],
  ['bingx', 'bingx'],
  ['blofin', 'blofin'],
  ['coinex', 'coinex'],
  ['phemex', 'phemex'],
  ['weex', 'weex'],
  ['xt', 'xt'],
]

/**
 * Resolve the affiliate referral for a trader's exchange source, or null when
 * no partnership is configured for it (→ no referral badge, plain link only).
 */
export function getAffiliateReferral(source: string | undefined): AffiliateReferral | null {
  if (!source) return null
  const s = source.toLowerCase()
  for (const [prefix, key] of PREFIX_TO_KEY) {
    if (s.startsWith(prefix)) return AFFILIATE_REFERRALS[key] ?? null
  }
  return AFFILIATE_REFERRALS[s] ?? null
}
