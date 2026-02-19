#!/usr/bin/env node
/**
 * Master Enrichment Loop - runs ALL enrichment scripts in sequence, loops until all gaps filled.
 * Designed to run forever on Mac Mini via launchd.
 * 
 * Logic:
 * 1. Query DB for WR null counts per source
 * 2. Run enrichment script for biggest gap
 * 3. After each script, re-check gaps
 * 4. If all gaps < threshold, sleep 1 hour then check again
 * 5. Never stop
 */
import { execSync, spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { readFileSync, existsSync, appendFileSync } from 'fs'
import path from 'path'

// Load env
const envPath = path.join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const LOG_FILE = '/tmp/enrich_master.log'
function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Map source -> best enrichment script (order of preference)
const ENRICH_SCRIPTS = {
  okx_web3: 'enrich_lr_okx_web3.mjs',       // API-based, no puppeteer
  gains: 'enrich_lr_gains.mjs',               // API-based
  gateio: 'enrich_lr_gateio_api.mjs',         // API-based
  kucoin: 'enrich_kucoin_v2.mjs',             // API-based  
  mexc: 'enrich_mexc_v3.mjs',                 // Puppeteer
  dydx: 'enrich_dydx_fills.mjs',             // API-based
  phemex: 'enrich_phemex.mjs',               // May need puppeteer
  bitfinex: 'enrich_bitfinex_wr_mdd.mjs',    // API-based
  aevo: 'enrich_lr_dydx_aevo.mjs',           // API-based
  bitget_futures: 'enrich_bitget_futures_lr3.mjs', // Puppeteer
}

// Fallback scripts if primary fails
const FALLBACK_SCRIPTS = {
  gains: 'enrich_gains_v2.mjs',
  gateio: 'enrich_gateio.mjs',
  kucoin: 'enrich_kucoin_wr.mjs',
  mexc: 'enrich_mexc_wr.mjs',
}

async function getGaps() {
  const sources = Object.keys(ENRICH_SCRIPTS)
  const gaps = []
  for (const source of sources) {
    const { count } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', source)
      .is('win_rate', null)
    if (count > 0) {
      gaps.push({ source, wrNull: count })
    }
  }
  gaps.sort((a, b) => b.wrNull - a.wrNull)
  return gaps
}

function runScript(scriptName, timeoutMinutes = 30) {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'import', scriptName)
    if (!existsSync(scriptPath)) {
      log(`⚠️ Script not found: ${scriptPath}`)
      resolve(false)
      return
    }

    log(`▶️ Running: ${scriptName} (timeout: ${timeoutMinutes}min)`)
    const child = spawn('node', [scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMinutes * 60 * 1000,
    })

    let output = ''
    child.stdout.on('data', d => {
      output += d.toString()
      // Log last line periodically
      const lines = d.toString().trim().split('\n')
      log(`  ${scriptName}: ${lines[lines.length - 1]}`)
    })
    child.stderr.on('data', d => {
      log(`  ${scriptName} ERR: ${d.toString().trim().split('\n')[0]}`)
    })

    const timer = setTimeout(() => {
      log(`⏰ Timeout: ${scriptName}`)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMinutes * 60 * 1000)

    child.on('close', (code) => {
      clearTimeout(timer)
      log(`✅ ${scriptName} exited with code ${code}`)
      resolve(code === 0)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      log(`❌ ${scriptName} error: ${err.message}`)
      resolve(false)
    })
  })
}

async function mainLoop() {
  log('🔄 Master Enrichment Loop started')
  
  let consecutiveNoProgress = 0
  
  while (true) {
    const gaps = await getGaps()
    const totalNull = gaps.reduce((s, g) => s + g.wrNull, 0)
    
    log(`\n📊 Current gaps (total WR null: ${totalNull}):`)
    for (const g of gaps) {
      log(`   ${g.source}: ${g.wrNull} WR null`)
    }
    
    if (totalNull === 0) {
      log('🎉 All gaps filled! Sleeping 1 hour...')
      await sleep(3600000)
      continue
    }
    
    // Run enrichment for each source with gaps, biggest first
    let madeProgress = false
    for (const gap of gaps) {
      if (gap.wrNull < 5) continue // skip tiny gaps
      
      const script = ENRICH_SCRIPTS[gap.source]
      if (!script) continue
      
      const beforeCount = gap.wrNull
      const success = await runScript(script, 30)
      
      // Check if we made progress
      const { count: afterCount } = await supabase
        .from('leaderboard_ranks')
        .select('*', { count: 'exact', head: true })
        .eq('source', gap.source)
        .is('win_rate', null)
      
      const reduced = beforeCount - (afterCount || 0)
      log(`📈 ${gap.source}: ${beforeCount} → ${afterCount} (reduced ${reduced})`)
      
      if (reduced > 0) madeProgress = true
      
      // If primary failed, try fallback
      if (reduced === 0 && FALLBACK_SCRIPTS[gap.source]) {
        log(`🔄 Trying fallback for ${gap.source}...`)
        await runScript(FALLBACK_SCRIPTS[gap.source], 20)
        
        const { count: afterFallback } = await supabase
          .from('leaderboard_ranks')
          .select('*', { count: 'exact', head: true })
          .eq('source', gap.source)
          .is('win_rate', null)
        
        const reducedFallback = beforeCount - (afterFallback || 0)
        if (reducedFallback > 0) madeProgress = true
        log(`📈 ${gap.source} fallback: ${beforeCount} → ${afterFallback} (reduced ${reducedFallback})`)
      }
      
      // Brief pause between scripts
      await sleep(5000)
    }
    
    if (!madeProgress) {
      consecutiveNoProgress++
      log(`⚠️ No progress this round (${consecutiveNoProgress} consecutive)`)
      if (consecutiveNoProgress >= 3) {
        log('💤 No progress 3 rounds in a row. Sleeping 30 min before retry...')
        await sleep(1800000)
        consecutiveNoProgress = 0
      }
    } else {
      consecutiveNoProgress = 0
    }
    
    log('🔄 Starting next round...\n')
    await sleep(10000) // 10s between rounds
  }
}

mainLoop().catch(err => {
  log(`💀 Fatal error: ${err.message}`)
  process.exit(1)
})
