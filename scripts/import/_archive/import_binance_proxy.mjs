/**
 * Binance Futures - 使用 curl + ClashX 代理
 */
import { execSync } from 'child_process'
import { clip, cs, sb, sleep } from './lib/index.mjs'

function curlFetch(url, body) {
  const cmd = `curl -s --proxy http://127.0.0.1:7890 --max-time 30 "${url}" -X POST -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" -H "Origin: https://www.binance.com" -d '${JSON.stringify(body)}'`
  try {
    const result = execSync(cmd, { encoding: 'utf8' })
    return JSON.parse(result)
  } catch (e) {
    return null
  }
}

async function main() {
  console.log('Binance Futures with ClashX proxy (curl)')
  
  // Test proxy
  const ipResult = execSync('curl -s --proxy http://127.0.0.1:7890 https://api.ipify.org?format=json', { encoding: 'utf8' })
  console.log('IP:', JSON.parse(ipResult).ip)
  
  const traders = []
  const API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  
  for (let page = 1; page <= 25; page++) {
    const data = curlFetch(API, {
      pageNumber: page,
      pageSize: 20,
      timeRange: '30D',
      dataType: 'ROI',
      order: 'DESC',
    })
    
    if (!data || !data.success || !data.data?.list?.length) {
      console.log(`Page ${page}: No data`)
      if (data?.code) console.log(`  Code: ${data.code}, Message: ${data.message}`)
      break
    }
    
    for (const t of data.data.list) {
      traders.push({
        id: t.leadPortfolioId || t.portfolioId,
        name: t.nickName || '',
        roi: t.roi != null ? parseFloat(t.roi) : null,
        pnl: t.pnl != null ? parseFloat(t.pnl) : null,
        wr: t.winRate != null ? parseFloat(t.winRate) : null,
        dd: t.maxDrawdown != null ? Math.abs(parseFloat(t.maxDrawdown)) : null,
        followers: parseInt(t.copierCount || 0) || null,
      })
    }
    
    console.log(`Page ${page}: +${data.data.list.length} → ${traders.length}`)
    if (traders.length >= 500) break
    await sleep(300)
  }
  
  console.log(`\nTotal: ${traders.length} traders`)
  
  if (traders.length > 0) {
    const now = new Date().toISOString()
    
    for (let i = 0; i < traders.length; i += 50) {
      await sb.from('trader_sources').upsert(traders.slice(i, i + 50).map(t => ({
        source: 'binance_futures', source_trader_id: t.id, handle: t.name || t.id,
        market_type: 'futures', is_active: true,
      })), { onConflict: 'source,source_trader_id' })
    }
    
    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const { error } = await sb.from('trader_snapshots').upsert(traders.slice(i, i + 30).map((t, j) => ({
        source: 'binance_futures', source_trader_id: t.id, season_id: '30D',
        rank: i + j + 1, roi: t.roi, pnl: t.pnl, win_rate: t.wr,
        max_drawdown: t.dd, followers: t.followers,
        arena_score: cs(t.roi, t.pnl, t.dd, t.wr), captured_at: now
      })), { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += Math.min(30, traders.length - i)
    }
    
    console.log(`Saved: ${saved}`)
  }
}

main().catch(e => console.log('Error:', e.message))
