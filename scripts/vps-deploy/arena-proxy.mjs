import http from 'node:http'

const PORT = 3456
const PROXY_KEY = process.env.PROXY_KEY || 'arena-proxy-sg-2026'

// All exchange hosts that Arena connectors need to reach
const ALLOWED_HOSTS = new Set([
  // Local scraper (Playwright on port 3457)
  'localhost:3457', '127.0.0.1:3457', '45.76.152.169:3457',
  // Binance
  'www.binance.com', 'web3.binance.com', 'api.binance.com', 'fapi.binance.com',
  // Bybit
  'www.bybit.com', 'api.bybit.com', 'api2.bybit.com', 'www.bybitglobal.com', 'api2.bybitglobal.com',
  // Bitget
  'www.bitget.com', 'api.bitget.com',
  // OKX
  'www.okx.com', 'api.okx.com',
  // MEXC
  'www.mexc.com', 'api.mexc.com', 'futures.mexc.com', 'contract.mexc.com',
  // CoinEx
  'www.coinex.com', 'api.coinex.com',
  // HTX (Huobi)
  'www.htx.com', 'api.htx.com', 'api.huobi.pro', 'futures.htx.com',
  // BingX
  'bingx.com', 'www.bingx.com', 'api-app.qq-os.com',
  // BloFin
  'openapi.blofin.com', 'www.blofin.com',
  // Gate.io
  'www.gate.com', 'gate.com', 'www.gate.io', 'api.gateio.ws',
  // BTCC
  'www.btcc.com', 'api.btcc.com',
  // Bitunix
  'api.bitunix.com', 'www.bitunix.com',
  // Bitfinex
  'api-pub.bitfinex.com', 'api.bitfinex.com',
  // Toobit
  'www.toobit.com', 'api.toobit.com',
  // XT
  'sapi.xt.com', 'www.xt.com',
  // eToro
  'www.etoro.com', 'api.etoro.com',
  // Phemex
  'phemex.com', 'www.phemex.com', 'api.phemex.com',
  // Weex
  'www.weex.com', 'api.weex.com', 'weex.com',
  // LBank
  'www.lbank.com', 'uuapi.rerrkvifj.com',
  // KuCoin (dead but keep for reference)
  'www.kucoin.com', 'api.kucoin.com',
  // Pionex
  'www.pionex.com',
  // Crypto.com
  'crypto.com', 'www.crypto.com',
  // DEX - Hyperliquid
  'stats-data.hyperliquid.xyz', 'api.hyperliquid.xyz',
  // DEX - dYdX
  'indexer.dydx.trade', 'indexer.v4.dydx.exchange', 'indexer.v4.testnet.dydx.exchange',
  // DEX - GMX
  'arbitrum-api.gmxinfra.io', 'gmx.squids.live', 'subgraph.satsuma-prod.com',
  // DEX - Gains
  'backend-arbitrum.gains.trade', 'backend-polygon.gains.trade',
  'backend-base.gains.trade', 'backend-global.gains.trade',
  // DEX - Drift
  'data.api.drift.trade',
  // DEX - Jupiter Perps
  'perps-api.jup.ag',
  // DEX - Aevo
  'api.aevo.xyz',
  // DEX - Kwenta / MUX (TheGraph)
  'api.thegraph.com', 'gateway.thegraph.com',
  // DeFi Llama + CoinGecko (for web3_bot)
  'api.llama.fi', 'api.coingecko.com',
  // Copin (fallback for dYdX, Kwenta)
  'api.copin.io',
])

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Key')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Health
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', region: 'sg', hosts: ALLOWED_HOSTS.size, ts: new Date().toISOString() }))
    return
  }

  // Auth
  if (req.headers['x-proxy-key'] !== PROXY_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // Accept POST to / or /proxy
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())

    const { url, method = 'GET', headers = {}, body: proxyBody } = body
    if (!url) { res.writeHead(400); res.end('{"error":"missing url"}'); return }

    // Validate host
    const target = new URL(url)
    if (!ALLOWED_HOSTS.has(target.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'host not allowed: ' + target.host }))
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const fetchOpts = {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json',
          ...headers,
        },
        signal: controller.signal,
      }
      if (proxyBody && method !== 'GET') {
        fetchOpts.body = typeof proxyBody === 'string' ? proxyBody : JSON.stringify(proxyBody)
        if (!fetchOpts.headers['Content-Type']) fetchOpts.headers['Content-Type'] = 'application/json'
      }

      const upstream = await fetch(url, fetchOpts)
      const data = await upstream.text()

      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' })
      res.end(data)
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' in use, retrying in 3s...')
    setTimeout(() => { server.close(); server.listen(PORT, '0.0.0.0') }, 3000)
  } else {
    console.error('Server error:', err)
    process.exit(1)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('Arena proxy v2 running on :' + PORT + ' (SG) — ' + ALLOWED_HOSTS.size + ' hosts allowed')
})
