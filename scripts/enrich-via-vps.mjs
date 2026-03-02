/**
 * 使用 VPS 代理的 Bitget 充实脚本
 * 解决 429 限流问题
 */

import { spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import fs from 'fs'

dotenv.config({ path: '.env.local' })

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const VPS_HOST = '45.76.152.169'

// 通过 VPS 执行请求
async function fetchViaVPS(url) {
  return new Promise((resolve, reject) => {
    const cmd = `ssh root@${VPS_HOST} "curl -s -H 'User-Agent: Mozilla/5.0' '${url}'"`
    
    const child = spawn('bash', ['-c', cmd])
    let stdout = ''
    let stderr = ''
    
    child.stdout.on('data', (data) => stdout += data)
    child.stderr.on('data', (data) => stderr += data)
    
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve(stdout)
        }
      } else {
        reject(new Error(`SSH failed: ${stderr}`))
      }
    })
  })
}

// Bitget 多时间段 ROI
async function fetchBitgetMultiPeriod(traderId) {
  const periods = ['7D', '30D', 'ALL']
  const results = { roi_7d: null, roi_30d: null, roi: null }
  
  for (const period of periods) {
    const url = `https://api.bitget.com/api/v2/copy/futures-trader/public/profit-detail?traderId=${traderId}&period=${period}`
    
    try {
      const data = await fetchViaVPS(url)
      if (data?.data?.roi !== undefined) {
        const roi = parseFloat(data.data.roi) * 100
        if (period === '7D') results.roi_7d = roi
        if (period === '30D') results.roi_30d = roi
        if (period === 'ALL') results.roi = roi
      }
    } catch (e) {
      console.error(`Error fetching ${period}:`, e.message)
    }
    
    await new Promise(r => setTimeout(r, 500)) // 间隔
  }
  
  return results
}

// Gateio 多时间段 ROI
async function fetchGateioMultiPeriod(traderId) {
  const url = `https://www.gate.com/api/futures_copy/copy_trader/detail?traderId=${traderId}`
  
  try {
    const data = await fetchViaVPS(url)
    return {
      roi_7d: data?.data?.roi_7d || null,
      roi_30d: data?.data?.roi_30d || null,
      roi: data?.data?.roi || null
    }
  } catch (e) {
    console.error('Gateio error:', e.message)
    return { roi_7d: null, roi_30d: null, roi: null }
  }
}

// 批量充实
async function enrichTraders(source, fetchFn) {
  // 获取需要充实的交易员
  const { data: traders } = await sb.from('trader_snapshots')
    .select('id, source_trader_id')
    .eq('source', source)
    .is('roi_7d', null)
    .limit(100)
  
  if (!traders?.length) {
    console.log(`No ${source} traders need enrichment`)
    return
  }
  
  console.log(`Enriching ${traders.length} ${source} traders via VPS...`)
  
  let updated = 0
  for (const t of traders) {
    const roi = await fetchFn(t.source_trader_id)
    
    if (roi.roi_7d || roi.roi_30d || roi.roi) {
      await sb.from('trader_snapshots')
        .update({
          roi_7d: roi.roi_7d,
          roi_30d: roi.roi_30d,
          roi: roi.roi
        })
        .eq('id', t.id)
      updated++
      console.log(`✅ ${t.source_trader_id}: 7d=${roi.roi_7d?.toFixed(1)}% 30d=${roi.roi_30d?.toFixed(1)}%`)
    }
    
    await new Promise(r => setTimeout(r, 1000)) // 1秒间隔
  }
  
  console.log(`\nDone: ${updated}/${traders.length} updated`)
}

// 主函数
const source = process.argv[2] || 'bitget_futures'

if (source === 'bitget_futures' || source === 'bitget_spot') {
  enrichTraders(source, fetchBitgetMultiPeriod)
} else if (source === 'gateio') {
  enrichTraders(source, fetchGateioMultiPeriod)
} else {
  console.log('Usage: node enrich-via-vps.mjs [bitget_futures|bitget_spot|gateio]')
}
