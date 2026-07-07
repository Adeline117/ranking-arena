/**
 * Server-side translation helper (U7-5).
 *
 * Mirrors the free Google `gtx` path used by app/api/translate/route.ts
 * (translateWithGoogle + fixCryptoTerms) but with NO auth and NO DB cache — it
 * is meant to be called from trusted server contexts (cron ingest, backfill
 * scripts) where we want a plain "translate this string" primitive.
 *
 * Free, no API key. Returns null on failure so callers can leave the target
 * column empty and let the frontend fall back to the English original — a failed
 * translation must NEVER block the caller's main flow (e.g. flash-news ingest).
 *
 * The `/api/translate` route may optionally reuse `translateWithGoogle` /
 * `fixCryptoTerms` from here, but is not required to (it keeps its GPT fallback
 * + cache layer, which this helper intentionally omits to stay $0).
 */

export type TranslateTarget = 'zh' | 'en' | 'ja' | 'ko'

// Google Translate `tl` code per target.
const GOOGLE_TARGET_CODE: Record<TranslateTarget, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
}

const GOOGLE_SOURCE_CODE: Record<TranslateTarget, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
}

/**
 * Post-process: fix common Google Translate errors for crypto/trading terms.
 * Kept in sync with app/api/translate/route.ts::fixCryptoTerms.
 */
export function fixCryptoTerms(text: string, targetLang: TranslateTarget): string {
  if (targetLang === 'zh') {
    return text
      .replace(/合同/g, '合约')
      .replace(/杠杆化/g, '杠杆')
      .replace(/长仓/g, '多仓')
      .replace(/空仓/g, '做空')
      .replace(/钱包地址/g, '钱包地址')
      .replace(/货币/g, '代币')
      .replace(/牛市/g, '牛市')
      .replace(/投资回报率/g, 'ROI')
      .replace(/最大跌幅/g, '最大回撤')
      .replace(/最大回落/g, '最大回撤')
      .replace(/最大降幅/g, '最大回撤')
      .replace(/胜率百分比/g, '胜率')
      .replace(/交易计数/g, '交易次数')
      .replace(/利润和损失/g, '盈亏')
      .replace(/损益/g, '盈亏')
      .replace(/清算/g, '爆仓')
      .replace(/现货交易/g, '现货')
      .replace(/期货交易/g, '合约')
      .replace(/去中心化交易所/g, 'DEX')
      .replace(/中心化交易所/g, 'CEX')
      .replace(/交易机器人/g, '交易Bot')
      .replace(/复制交易/g, '跟单')
      .replace(/跟随交易/g, '跟单')
  }
  return text
}

/**
 * Translate via the free Google Translate `gtx` endpoint (no API key, ~100ms).
 * Returns null on any failure (network, timeout, unexpected shape).
 */
export async function translateWithGoogle(
  text: string,
  target: TranslateTarget,
  source: TranslateTarget = 'en',
  timeoutMs = 5000
): Promise<string | null> {
  const tl = GOOGLE_TARGET_CODE[target] ?? 'en'
  const sl = GOOGLE_SOURCE_CODE[source] ?? 'auto'

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null

    const data = await response.json()
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null

    // Concatenate all translated segments
    const translated = data[0]
      .filter((segment: unknown[]) => Array.isArray(segment) && segment[0])
      .map((segment: unknown[]) => segment[0])
      .join('')

    return translated || null
  } catch {
    // Best-effort — caller falls back to the original text.
    return null
  }
}

/**
 * Translate `text` from `source` to `target` using the free gtx endpoint, then
 * apply crypto-term fixups. Returns null on failure (caller should leave the
 * target column empty and rely on the frontend English fallback).
 *
 * If source === target the input is returned unchanged.
 */
export async function translateText(
  text: string,
  target: TranslateTarget,
  source: TranslateTarget = 'en',
  timeoutMs = 5000
): Promise<string | null> {
  const trimmed = (text || '').trim()
  if (!trimmed) return null
  if (source === target) return trimmed

  const raw = await translateWithGoogle(trimmed, target, source, timeoutMs)
  if (!raw) return null
  return fixCryptoTerms(raw, target)
}
