/**
 * Kwenta Playwright Scraper Handler
 *
 * Kwenta runs on kwenta.eth.limo (ENS gateway).
 * The main API is suspended (503) but the dApp may still load
 * leaderboard data from Synthetix contracts or subgraph.
 *
 * Deploy to VPS scraper: /opt/scraper/handlers/kwenta.mjs
 * Register endpoint: /kwenta/leaderboard
 */

export default async function handleKwenta(page, params = {}) {
  const { pageSize = 100 } = params
  const traders = []

  page.on('response', async (response) => {
    const url = response.url()
    if ((url.includes('leaderboard') || url.includes('stats') || url.includes('perps')
         || url.includes('thegraph') || url.includes('subgraph'))
        && response.status() === 200) {
      try {
        const text = await response.text()
        if (text.startsWith('{') || text.startsWith('[')) {
          const data = JSON.parse(text)
          // GraphQL response shape
          const list = data?.data?.futuresStats || data?.data?.traders
            || data?.data?.accounts || data?.results || []
          if (Array.isArray(list) && list.length > 0) {
            for (const t of list) {
              traders.push({
                traderId: t.account || t.id || t.address,
                nickName: null, // Kwenta uses wallet addresses
                roi: null, // Computed from PnL/volume
                pnl: t.pnlWithFeesPaid || t.totalPnl || t.pnl,
                winRate: null,
                tradesCount: t.totalTrades || t.trades,
                volume: t.totalVolume || t.volume,
              })
            }
          }
        }
      } catch { /* ignore */ }
    }
  })

  // Try ENS gateway first
  try {
    await page.goto('https://kwenta.eth.limo/leaderboard', {
      waitUntil: 'networkidle',
      timeout: 45000,
    })
  } catch {
    // Fallback to direct domain
    await page.goto('https://kwenta.io/leaderboard', {
      waitUntil: 'networkidle',
      timeout: 30000,
    })
  }

  await page.waitForTimeout(8000) // ENS gateway + subgraph queries are slow

  return { traders: traders.slice(0, pageSize), total: traders.length }
}
