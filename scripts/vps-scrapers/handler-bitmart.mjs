/**
 * BitMart Playwright Scraper Handler
 *
 * BitMart's API is behind Cloudflare (403 on all requests).
 * The website loads data via internal APIs that bypass CF when
 * accessed through a real browser session.
 *
 * Deploy to VPS scraper: /opt/scraper/handlers/bitmart.mjs
 * Register endpoint: /bitmart/leaderboard
 */

export default async function handleBitMart(page, params = {}) {
  const { pageSize = 50 } = params
  const traders = []

  page.on('response', async (response) => {
    const url = response.url()
    if ((url.includes('copy-trade') || url.includes('copytrade') || url.includes('trader/list'))
        && response.status() === 200
        && response.headers()['content-type']?.includes('json')) {
      try {
        const data = await response.json()
        const list = data?.data?.list || data?.data?.records || data?.data?.traders || []
        if (Array.isArray(list) && list.length > 0) {
          for (const t of list) {
            traders.push({
              traderId: t.traderId || t.uid || t.id,
              nickName: t.nickName || t.nickname || t.name,
              roi: t.roi || t.returnRate || t.profitRate,
              pnl: t.pnl || t.profit || t.totalPnl,
              winRate: t.winRate || t.winRatio,
              maxDrawdown: t.maxDrawdown || t.mdd,
              followers: t.followerCount || t.followers,
              avatar: t.avatar || t.avatarUrl,
            })
          }
        }
      } catch { /* ignore */ }
    }
  })

  await page.goto('https://www.bitmart.com/copy-trading', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  await page.waitForTimeout(5000)

  return { traders: traders.slice(0, pageSize), total: traders.length }
}
