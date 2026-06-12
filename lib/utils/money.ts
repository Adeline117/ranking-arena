/**
 * Currency-safe money rendering (spec §5.8): four quote units exist in
 * the wild (USDT, USDx on Bybit MT5/Gate CFD, USDC on gTrade/OKX web3,
 * literal USD on Bitfinex rankings).
 * Never sum or rank across mismatched units; always label the unit.
 * (Precision arithmetic helpers live in lib/utils/currency.ts.)
 */

import type { Money, ServingCurrency } from '@/lib/data/serving/types'

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})
const PLAIN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export interface FormatMoneyOptions {
  compact?: boolean
  signed?: boolean
  /** USDT can stay visually quiet; USDx/USDC are ALWAYS shown. */
  hideUsdtSuffix?: boolean
}

export function formatMoney(m: Money, opts: FormatMoneyOptions = {}): string {
  const { compact = true, signed = false, hideUsdtSuffix = false } = opts
  const nf = compact ? COMPACT : PLAIN
  const sign = signed && m.value > 0 ? '+' : ''
  const num = `${sign}$${nf.format(m.value)}`
  if (m.currency === 'USDT' && hideUsdtSuffix) return num
  return `${num} ${m.currency}`
}

/**
 * Sum a list of Money values. Returns null on mixed currencies — render
 * "—" with the mixedCurrencyTooltip instead of silently lying.
 */
export function sumMoney(list: Money[]): Money | null {
  if (list.length === 0) return null
  const currency = list[0].currency
  let total = 0
  for (const m of list) {
    if (m.currency !== currency) return null
    total += m.value
  }
  return { value: total, currency }
}

/** Dev-mode guard for aggregation code paths. */
export function assertSameCurrency(list: Money[]): void {
  if (process.env.NODE_ENV !== 'production' && list.length > 1) {
    const first = list[0].currency
    const mixed = list.find((m) => m.currency !== first)
    if (mixed) {
      throw new Error(
        `[money] mixed-unit aggregation: ${first} + ${mixed.currency} — ` +
          `group by currency or render "—" (spec §5.8)`
      )
    }
  }
}

export function money(value: number, currency: ServingCurrency): Money {
  return { value, currency }
}
