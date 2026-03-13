/**
 * KuCoin Playwright Scraper Handler
 *
 * KuCoin's copy trading page (kucoin.com/copytrading) is a React SPA.
 * All APIs return 404 but the frontend loads data via internal XHR calls.
 * This handler intercepts those calls.
 *
 * Deploy to VPS scraper: /opt/scraper/handlers/kucoin.mjs
 * Register endpoint: /kucoin/leaderboard
 */

export default async function handleKuCoin(page, params = {}) {
  const { pageSize = 50, period = '7d' } = params
  const traders = []
  let captured = false

  // Intercept API responses
  page.on('response', async (response) => {
    const url = response.url()
    // KuCoin internal APIs use _api/ prefix
    if ((url.includes('copytrading') || url.includes('copy-trade') || url.includes('leader'))
        && response.status() === 200
        && response.headers()['content-type']?.includes('json')) {
      try {
        const data = await response.json()
        // Extract trader list from various response shapes
        const list = data?.data?.list || data?.data?.items || data?.items || data?.list || []
        if (Array.isArray(list) && list.length > 0) {
          for (const t of list) {
            traders.push({
              traderId: t.leaderId || t.uid || t.userId || t.id,
              nickName: t.nickName || t.nickname || t.name,
              roi: t.roi || t.returnRate || t.profitRate,
              pnl: t.pnl || t.profit || t.totalProfit,
              winRate: t.winRate || t.winRatio,
              maxDrawdown: t.maxDrawdown || t.mdd,
              followers: t.followerCount || t.followers || t.copyCount,
              avatar: t.avatar || t.avatarUrl,
            })
          }
          captured = true
        }
      } catch { /* ignore parse errors */ }
    }
  })

  // Navigate to copy trading page
  await page.goto('https://www.kucoin.com/copytrading', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  // Wait for data to load (SPA takes time)
  await page.waitForTimeout(5000)

  // If no data captured via interception, try scrolling to trigger lazy load
  if (!captured) {
    await page.evaluate(() => window.scrollTo(0, 500))
    await page.waitForTimeout(3000)
  }

  return { traders: traders.slice(0, pageSize), total: traders.length }
}
