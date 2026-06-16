#!/usr/bin/env node
/**
 * Audit what every serving source's trader detail page actually renders.
 * Categorizes each as rich / medium / sparse / broken so we can see which
 * sources still lack a rich unified frontend.
 */
import { chromium } from 'playwright'

const TARGETS = [
  ['binance_futures', '4908633203782592768'],
  ['binance_spot', '4265626982574801920'],
  ['binance_web3_bsc', '0xe0d16bd8a6aca1f4de54bce54e7fc08c0a3eb0d3'],
  ['bingx_futures', '1478952263075274800'],
  ['bitfinex', 'Natural9Nine2'],
  ['bitget_bots_futures', '1447012062382944256'],
  ['bitget_bots_spot', '1440880452658610176'],
  ['bitget_cfd', 'b0b7467f8ab43d5eac93'],
  ['bitget_futures', 'bfb24a7f8cb2395fa595'],
  ['bitget_spot', 'bab24c7f8bb53b52a597'],
  ['bitmart_futures', '5g1tKQxIR8aQcz-x-L3bKg'],
  ['bitunix_futures', '657833111'],
  ['blofin_futures', '18694361868'],
  ['blofin_spot', '51971304382'],
  ['btcc_futures', '1082211'],
  ['bybit_copytrade', '92UaWU1drDTRVgCzoEju4g=='],
  ['bybit_mt5', 'X/Wqamfa0e4n0hTf/d5Zsg=='],
  ['coinex_futures', '6B85E4EB'],
  ['gate_cfd', '1775496836706526'],
  ['gate_futures', '6217'],
  ['gmx', '0x1fa0152a66e390f049863a3d30772b9674cf3c92'],
  ['gtrade', '0x50915a2773b782d3bc1d05fcbada0903029e30b4'],
  ['htx_futures', '424708902'],
  ['htx_spot', '580728443'],
  ['hyperliquid', '0x9e2cbb5d800181c1ef21b25010dc4ea80eeb5508'],
  ['kucoin_futures', '1006946'],
  ['lbank_futures', 'LBA9G27637'],
  ['mexc_futures', '86658642'],
  ['okx_futures', '742936864373631567'],
  ['okx_spot', 'BD0C2CADA544ED43'],
  ['okx_web3_solana', 'A3MkNe815H2BScuo9UjUmmwfpCPEhSvDjrzzNWeq2SnX'],
  ['phemex_futures', '9175166'],
  ['toobit_futures', '16172705'],
  ['xt_futures', '4612424232329176550'],
  ['xt_spot', '4612465369934908614'],
]

const METRIC_LABELS = [
  'ROI',
  'PnL',
  'Win Rate',
  'Max Drawdown',
  'Sharpe',
  'Sortino',
  'Calmar',
  'Volatility',
  'Copier',
  'AuM',
  'Winning Trades',
  'Total Trades',
  'Profit Share',
  'Avg Holding',
  'NAV',
  'Annualized',
  'Total ROI',
  'Total PnL',
  'Largest Win',
  'Largest Loss',
  'Avg Win',
  'Avg Loss',
  'Long/Short',
  'Trades/Week',
  'Profit Days',
  'Loss Days',
  'Unrealized PnL',
  'Realized PnL',
  'Closed Trades',
  'Lifetime Trades',
  'Lifetime Volume',
  'Lifetime Win Rate',
]

async function audit(ctx, [src, id]) {
  const p = await ctx.newPage()
  const url = `https://www.arenafi.org/trader/${encodeURIComponent(id)}?platform=${src}&_=${Date.now()}`
  let res = {
    src,
    notFound: false,
    perf: false,
    metrics: 0,
    chart: false,
    drawdown: false,
    radar: false,
    holding: false,
    asset: false,
    records: 0,
    error: false,
  }
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await p.waitForTimeout(7000)
    res = await p.evaluate((labels) => {
      const txt = document.body.innerText
      const has = (s) => txt.includes(s)
      const recordTabs = ['Position History', 'Positions', 'Orders', 'Transfers', 'Copiers'].filter(
        (t) => txt.includes(t)
      ).length
      return {
        notFound: /Trader Not Found/i.test(txt),
        error: /Something went wrong|出错了/i.test(txt),
        perf: has('Performance'),
        metrics: labels.filter((l) => has(l)).length,
        chart: !!document.querySelector('svg'),
        drawdown: has('Drawdown'),
        radar: has('Trading Ability'),
        holding: has('Holding Duration'),
        asset: has('Asset Preference'),
        chips: has('Labels by the exchange') || has('Risk Rating'),
        meta: has('Last trade') || has('Days trading') || has('Days leading'),
        records: recordTabs,
      }
    }, METRIC_LABELS)
    res.src = src
  } catch (e) {
    res = {
      src,
      notFound: false,
      perf: false,
      metrics: 0,
      chart: false,
      error: 'LOAD:' + e.message.slice(0, 30),
    }
  }
  await p.close()
  // categorize
  let cat = 'broken'
  if (res.notFound) cat = 'NOTFOUND'
  else if (res.error) cat = 'ERROR'
  else if (
    res.metrics >= 6 ||
    res.radar ||
    res.holding ||
    (res.metrics >= 4 && (res.chips || res.meta))
  )
    cat = 'RICH'
  else if (res.perf && (res.metrics >= 3 || res.chips || res.meta || res.records >= 2))
    cat = 'medium'
  else if (res.perf) cat = 'sparse'
  const mods = [
    res.chart && 'chart',
    res.drawdown && 'dd',
    res.radar && 'radar',
    res.holding && 'hold',
    res.asset && 'asset',
    res.chips && 'chips',
    res.meta && 'meta',
    res.records && `rec:${res.records}`,
  ]
    .filter(Boolean)
    .join(',')
  console.log(`${cat.padEnd(9)} ${src.padEnd(20)} metrics=${res.metrics} [${mods}]`)
  return { ...res, cat }
}

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'en-US' })
const results = []
for (const t of TARGETS) results.push(await audit(ctx, t))
await b.close()
console.log('\n=== SUMMARY ===')
const by = {}
for (const r of results) by[r.cat] = (by[r.cat] || 0) + 1
console.log(JSON.stringify(by))
console.log(
  'NEEDS WORK:',
  results
    .filter((r) => ['NOTFOUND', 'ERROR', 'sparse', 'broken'].includes(r.cat))
    .map((r) => r.src)
    .join(', ')
)
