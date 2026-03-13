/**
 * BTSE Playwright Scraper Handler
 *
 * BTSE's copy-trading page returns 200 (SPA) but all API endpoints 404.
 * The page preconnects to api.btse.com — the real API calls happen
 * inside the SPA after JS execution.
 *
 * Deploy to VPS scraper: /opt/scraper/handlers/btse.mjs
 * Register endpoint: /btse/leaderboard
 */

export default async function handleBTSE(page, params = {}) {
  const { pageSize = 50 } = params
  const traders = []

  page.on('response', async (response) => {
    const url = response.url()
    if ((url.includes('copy-trading') || url.includes('leaderboard') || url.includes('leader'))
        && url.includes('api.btse.com')
        && response.status() === 200) {
      try {
        const data = await response.json()
        const list = data?.data || data?.leaders || data?.traders || data?.list || []
        if (Array.isArray(list) && list.length > 0) {
          for (const t of list) {
            traders.push({
              traderId: t.traderId || t.uid || t.userId || t.id,
              nickName: t.nickname || t.nickName || t.name || t.displayName,
              roi: t.roi || t.returnRate || t.profitRate,
              pnl: t.pnl || t.profit || t.totalPnl,
              winRate: t.winRate || t.winRatio,
              maxDrawdown: t.maxDrawdown || t.mdd,
              followers: t.followerCount || t.followers || t.copiers,
              avatar: t.avatar || t.avatarUrl,
            })
          }
        }
      } catch { /* ignore */ }
    }
  })

  await page.goto('https://www.btse.com/en/futures/copy-trading', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  await page.waitForTimeout(5000)

  // Scroll to trigger lazy load
  await page.evaluate(() => window.scrollTo(0, 600))
  await page.waitForTimeout(3000)

  return { traders: traders.slice(0, pageSize), total: traders.length }
}
