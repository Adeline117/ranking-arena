#!/usr/bin/env node
/**
 * API Response Snapshot Script
 *
 * On each successful fetch, saves a raw API response sample.
 * Keeps last 7 days only.
 * When an exchange API changes, AI can diff old vs new to find changes.
 *
 * Usage:
 *   node scripts/snapshot-api-responses.mjs
 *
 * Schedule: daily via OpenClaw or manual
 */

import { writeFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'snapshots')
const RETENTION_DAYS = 7

const EXCHANGE_ENDPOINTS = {
  binance_futures: {
    url: 'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT',
    method: 'GET',
  },
  bybit: {
    url: 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
    method: 'GET',
  },
  okx: {
    url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP',
    method: 'GET',
  },
  bitget: {
    url: 'https://api.bitget.com/api/v2/mix/market/ticker?symbol=BTCUSDT&productType=USDT-FUTURES',
    method: 'GET',
  },
  hyperliquid: {
    url: 'https://api.hyperliquid.xyz/info',
    method: 'POST',
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    headers: { 'Content-Type': 'application/json' },
  },
  mexc: {
    url: 'https://api.mexc.com/api/v3/ticker/24hr?symbol=BTCUSDT',
    method: 'GET',
  },
  kucoin: {
    url: 'https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT',
    method: 'GET',
  },
  gateio: {
    url: 'https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT',
    method: 'GET',
  },
  htx: {
    url: 'https://api.huobi.pro/market/detail/merged?symbol=btcusdt',
    method: 'GET',
  },
  coinex: {
    url: 'https://api.coinex.com/v2/spot/ticker?market=BTCUSDT',
    method: 'GET',
  },
}

async function fetchSnapshot(name, config) {
  try {
    const res = await fetch(config.url, {
      method: config.method || 'GET',
      headers: config.headers || {},
      body: config.body || undefined,
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      return { exchange: name, status: res.status, error: `HTTP ${res.status}` }
    }

    const data = await res.json()
    return { exchange: name, status: 200, data }
  } catch (err) {
    return { exchange: name, status: 0, error: err.message }
  }
}

function cleanOldSnapshots() {
  if (!existsSync(SNAPSHOT_DIR)) return

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000

  for (const dir of readdirSync(SNAPSHOT_DIR)) {
    const dirPath = path.join(SNAPSHOT_DIR, dir)
    try {
      const files = readdirSync(dirPath)
      for (const file of files) {
        // File format: 2026-03-06.json
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]).getTime()
          if (fileDate < cutoff) {
            rmSync(path.join(dirPath, file))
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

async function main() {
  const date = new Date().toISOString().split('T')[0]

  console.log(`=== API Response Snapshots — ${date} ===\n`)

  // Clean old snapshots first
  cleanOldSnapshots()

  const results = []

  for (const [name, config] of Object.entries(EXCHANGE_ENDPOINTS)) {
    process.stdout.write(`  ${name}... `)
    const result = await fetchSnapshot(name, config)

    if (result.data) {
      // Save snapshot
      const exchangeDir = path.join(SNAPSHOT_DIR, name)
      if (!existsSync(exchangeDir)) {
        mkdirSync(exchangeDir, { recursive: true })
      }
      writeFileSync(
        path.join(exchangeDir, `${date}.json`),
        JSON.stringify(result.data, null, 2)
      )
      console.log(`OK (${JSON.stringify(result.data).length} bytes)`)
    } else {
      console.log(`FAILED: ${result.error}`)
    }

    results.push({
      exchange: name,
      ok: !!result.data,
      error: result.error,
    })
  }

  const success = results.filter((r) => r.ok).length
  console.log(`\nDone: ${success}/${results.length} exchanges captured`)
}

main().catch(console.error)
