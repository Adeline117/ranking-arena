/**
 * Shared trader extraction from API JSON responses
 * Recursively searches nested objects for trader-like data
 */

const ID_KEYS = ['traderId','traderUid','uid','leaderId','encryptedUid','leadPortfolioId','copyTradeId','leaderMark','userId','trader_id','address','id']
const ROI_KEYS = ['yieldRate','roi','roiRate','totalRoi','pnlRate','returnRate','periodRoi','copyTradeRoi','incomeRate']
const PNL_KEYS = ['totalProfit','profit','pnl','totalPnl','total_profit','income']
const WR_KEYS = ['winRate','win_rate','winRatio']
const DD_KEYS = ['maxDrawDown','maxDrawdown','mdd','drawDown']

export function extractTraders(obj, depth = 0) {
  const results = []
  if (depth > 5 || !obj) return results

  if (Array.isArray(obj) && obj.length >= 2) {
    for (const it of obj) {
      if (!it || typeof it !== 'object') continue
      const keys = Object.keys(it)
      const hasId = keys.some(k => /trader|uid|leader|address|portfolio|userId|copyTrade|leaderMark/i.test(k)) || it.id
      const hasMetric = keys.some(k => /roi|pnl|yield|profit|winRate|return|income/i.test(k))
      const hasName = keys.some(k => /nick|name|displayName/i.test(k))
      if (!hasId || (!hasMetric && !hasName)) continue

      let id = ''
      for (const k of ID_KEYS) {
        if (it[k] != null && String(it[k]).length > 1) { id = String(it[k]); break }
      }
      if (!id) continue

      let roi = null
      for (const k of ROI_KEYS) {
        if (it[k] != null) { roi = parseFloat(it[k]); if (Math.abs(roi) < 20 && roi !== 0 && k !== 'roi') roi *= 100; break }
      }

      let pnl = null
      for (const k of PNL_KEYS) { if (it[k] != null) { pnl = parseFloat(it[k]); break } }

      let wr = null
      for (const k of WR_KEYS) { if (it[k] != null) { wr = parseFloat(it[k]); if (wr > 0 && wr <= 1) wr *= 100; break } }

      let dd = null
      for (const k of DD_KEYS) { if (it[k] != null) { dd = Math.abs(parseFloat(it[k])); if (dd > 0 && dd < 1) dd *= 100; break } }

      results.push({
        id,
        name: it.nickName || it.nickname || it.leaderName || it.name || it.displayName || '',
        avatar: it.headUrl || it.avatarUrl || it.avatar || it.userPhoto || it.portraitUrl || null,
        roi, pnl, wr, dd,
        trades: parseInt(it.totalOrderNum || it.closedCount || it.tradeCount || 0) || null
      })
    }
  }

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj)) results.push(...extractTraders(v, depth + 1))
  }
  return results
}
