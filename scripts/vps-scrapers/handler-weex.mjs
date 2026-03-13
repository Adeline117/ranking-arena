/**
 * WEEX Playwright Scraper Handler
 *
 * WEEX website is alive (weex.com returns 200) but API endpoints return 521.
 * The copy-trade page at /en/copy-trade loads data via XHR.
 *
 * Deploy to VPS scraper: /opt/scraper/handlers/weex.mjs
 * Register endpoint: /weex/leaderboard
 */

export default async function handleWEEX(page, params = {}) {
  const { pageSize = 50 } = params
  const traders = []

  page.on('response', async (response) => {
    const url = response.url()
    if ((url.includes('copy-trade') || url.includes('copy_trade') || url.includes('trader/rank'))
        && response.status() === 200
        && response.headers()['content-type']?.includes('json')) {
      try {
        const data = await response.json()
        const list = data?.data?.list || data?.data?.records || data?.data || []
        if (Array.isArray(list) && list.length > 0) {
          for (const t of list) {
            traders.push({
              traderId: t.uid || t.traderId || t.id,
              nickName: t.nickName || t.nickname,
              roi: t.roi || t.returnRate,
              pnl: t.pnl || t.profit,
              winRate: t.winRate,
              maxDrawdown: t.maxDrawdown || t.mdd,
              followers: t.followerCount || t.followers,
              avatar: t.avatar || t.avatarUrl,
            })
          }
        }
      } catch { /* ignore */ }
    }
  })

  await page.goto('https://www.weex.com/en/copy-trade', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  await page.waitForTimeout(5000)

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, 800))
  await page.waitForTimeout(3000)

  return { traders: traders.slice(0, pageSize), total: traders.length }
}
