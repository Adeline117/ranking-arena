/**
 * Cloudflare Worker - Exchange API Proxy
 *
 * 绕过交易所对云服务商 IP 的封锁
 * Cloudflare 的 IP 池通常不被封锁
 */

interface Env {
  ALLOWED_ORIGINS: string;
  PROXY_SECRET?: string;
}

// Default allowed origins for CORS (override via ALLOWED_ORIGINS env var)
const DEFAULT_ALLOWED_ORIGINS = [
  'https://www.arenafi.org',
  'https://arenafi.org',
  'https://ranking-arena.vercel.app',
];

// Per-request origin (set in fetch handler, never wildcard)
let _requestOrigin = 'https://www.arenafi.org';

/** Return CORS header value scoped to validated origin */
function corsOrigin(): string {
  return _requestOrigin;
}

// Supported exchange API allow-list
const ALLOWED_HOSTS = [
  // VPS Playwright scraper (relay for WAF-blocked exchanges)
  '45.76.152.169:3457',
  '45.76.152.169:3456',
  'www.binance.com',
  'api.binance.com',
  'fapi.binance.com',
  'www.bybit.com',
  'api.bybit.com',
  'api2.bybit.com',
  'www.bitget.com',
  'api.bitget.com',
  'www.mexc.com',
  'api.mexc.com',
  'futures.mexc.com',
  'contract.mexc.com',
  'www.okx.com',
  'api.okx.com',
  'www.kucoin.com',
  'api.kucoin.com',
  'www.coinex.com',
  'api.coinex.com',
  'www.htx.com',
  'api.htx.com',
  'contract.htx.com',
  'api.huobi.pro',
  'api.hbdm.com',
  'api.gmx.io',
  'api.dydx.exchange',
  'api.hyperliquid.xyz',
  // dYdX v4 indexer
  'indexer.dydx.trade',
  'indexer.v4testnet.dydx.exchange',
  // BloFin copy trading
  'openapi.blofin.com',
  // BingX internal API (CF-blocked directly, accessible via Worker)
  'api-app.qq-os.com',
  'bingx.com',
  // Gains Network (gTrade) — all chain backends
  'backend-arbitrum.gains.trade',
  'backend-polygon.gains.trade',
  'backend-base.gains.trade',
  'backend-global.gains.trade',
  // GMX stats
  'arbitrum-api.gmxinfra.io',
  'gmx.squids.live',
  // Pionex copy trading
  'www.pionex.com',
  // Crypto.com copy trading
  'crypto.com',
  // LBank copy trading
  'www.lbank.com',
  // Gate.io copy trading
  'www.gate.com',
  // Bitunix copy trading
  'api.bitunix.com',
  // Drift DEX
  'data.api.drift.trade',
  // Paradex DEX
  'api.prod.paradex.trade',
  // BitMart copy trading (geo-restricted, needs US/EU IP)
  'www.bitmart.com',
  'api-cloud.bitmart.com',
  // Phemex copy trading (CloudFront blocks all VPS IPs, CF Worker may bypass)
  'api.phemex.com',
  'www.phemex.com',
  // eToro rankings
  'www.etoro.com',
  // HTX futures ranking
  'futures.htx.com',
  // Toobit copy trading
  'www.toobit.com',
  // XT copy trading
  'www.xt.com',
  'sapi.xt.com',
  'fapi.xt.com',
  // Bitfinex rankings
  'api-pub.bitfinex.com',
  // Jupiter Perps
  'perps-api.jup.ag',
  // Aevo
  'api.aevo.xyz',
  // Copin (dYdX fallback)
  'api.copin.io',
  // Subsquid (GMX)
  'gmx.squids.live',
];

const worker = {

  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // 验证来源
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = env.ALLOWED_ORIGINS
      ? (env.ALLOWED_ORIGINS).split(',').map(o => o.trim())
      : DEFAULT_ALLOWED_ORIGINS;

    // Determine CORS origin for this request — never use wildcard
    if (origin && allowedOrigins.some(o => origin === o || (origin.endsWith(o) && (o.startsWith('.') || origin.length === o.length || origin[origin.length - o.length - 1] === '.')))) {
      _requestOrigin = origin;
    } else {
      // Server-to-server or unrecognized origin — use first allowed origin
      _requestOrigin = allowedOrigins[0] || 'https://www.arenafi.org';
    }

    if (!allowedOrigins.some(o => origin === o || (origin.endsWith(o) && (o.startsWith('.') || origin.length === o.length || origin[origin.length - o.length - 1] === '.'))) && origin !== '') {
      // 也允许没有 Origin 的请求（服务器到服务器）
      const proxySecret = request.headers.get('X-Proxy-Secret');
      if (env.PROXY_SECRET && proxySecret !== env.PROXY_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // 代理请求: /proxy?url=<encoded_url>
    if (url.pathname === '/proxy') {
      return handleProxy(request, env);
    }

    // 快捷端点: /binance/copy-trading
    if (url.pathname === '/binance/copy-trading') {
      return handleBinanceCopyTrading(request, url);
    }

    // 快捷端点: /bybit/copy-trading
    if (url.pathname === '/bybit/copy-trading') {
      return handleBybitCopyTrading(request, url);
    }

    // 快捷端点: /bitget/copy-trading
    if (url.pathname === '/bitget/copy-trading') {
      return handleBitgetCopyTrading(request, url);
    }

    // 快捷端点: /kucoin/copy-trading
    if (url.pathname === '/kucoin/copy-trading') {
      return handleKuCoinCopyTrading(request, url);
    }

    // 快捷端点: /binance/spot-copy-trading
    if (url.pathname === '/binance/spot-copy-trading') {
      return handleBinanceSpotCopyTrading(request, url);
    }

    // 快捷端点: /mexc/copy-trading
    if (url.pathname === '/mexc/copy-trading') {
      return handleMexcCopyTrading(request, url);
    }

    // 快捷端点: /htx/copy-trading
    if (url.pathname === '/htx/copy-trading') {
      return handleHtxCopyTrading(request, url);
    }

    // Shortcut: /coinex/copy-trading
    if (url.pathname === '/coinex/copy-trading') {
      return handleCoinexCopyTrading(request, url);
    }

    // Shortcut: /gateio/copy-trading
    if (url.pathname === '/gateio/copy-trading') {
      return handleGateioCopyTrading(request, url);
    }

    // Shortcut: /bitunix/copy-trading
    if (url.pathname === '/bitunix/copy-trading') {
      return handleBitunixCopyTrading(request, url);
    }

    // Shortcut: /drift/leaderboard
    if (url.pathname === '/drift/leaderboard') {
      return handleDriftLeaderboard(request, url);
    }

    // Shortcut: /paradex/leaderboard
    if (url.pathname === '/paradex/leaderboard') {
      return handleParadexLeaderboard(request, url);
    }

    // Shortcut: /bingx/leaderboard
    if (url.pathname === '/bingx/leaderboard') {
      return handleBingxLeaderboard(request, url);
    }

    // Shortcut: /bingx/trader-detail
    if (url.pathname === '/bingx/trader-detail') {
      return handleBingxTraderDetail(request, url);
    }

    // Shortcut: /bingx/trader-positions (current open positions)
    if (url.pathname === '/bingx/trader-positions') {
      return handleBingxTraderPositions(request, url);
    }

    // Shortcut: /blofin/leaderboard
    if (url.pathname === '/blofin/leaderboard') {
      return handleBlofinLeaderboard(request, url);
    }

    // Shortcut: /blofin/trader-info
    if (url.pathname === '/blofin/trader-info') {
      return handleBlofinTraderInfo(request, url);
    }

    // Shortcut: /gains/leaderboard-all
    if (url.pathname === '/gains/leaderboard-all') {
      return handleGainsLeaderboardAll(request, url);
    }

    // Shortcut: /gains/open-trades
    if (url.pathname === '/gains/open-trades') {
      return handleGainsOpenTrades(request, url);
    }

    // Shortcut: /gains/trader-stats
    if (url.pathname === '/gains/trader-stats') {
      return handleGainsTraderStats(request, url);
    }

    // 快捷端点: /dydx/leaderboard
    if (url.pathname === '/dydx/leaderboard') {
      return handleDydxLeaderboard(request, url);
    }

    // 快捷端点: /dydx/historical-pnl
    if (url.pathname === '/dydx/historical-pnl') {
      return handleDydxHistoricalPnl(request, url);
    }

    // 快捷端点: /dydx/subaccount
    if (url.pathname === '/dydx/subaccount') {
      return handleDydxSubaccount(request, url);
    }

    return Response.json({
      error: 'Not found',
      endpoints: [
        '/health', '/proxy',
        '/binance/copy-trading', '/binance/spot-copy-trading',
        '/bybit/copy-trading', '/bitget/copy-trading', '/kucoin/copy-trading',
        '/mexc/copy-trading', '/htx/copy-trading',
        '/coinex/copy-trading', '/gateio/copy-trading', '/bitunix/copy-trading',
        '/drift/leaderboard', '/paradex/leaderboard',
        '/dydx/leaderboard', '/dydx/historical-pnl', '/dydx/subaccount',
        '/blofin/leaderboard', '/blofin/trader-info',
        '/bingx/leaderboard', '/bingx/trader-detail', '/bingx/trader-positions',
        '/gains/leaderboard-all', '/gains/open-trades', '/gains/trader-stats',
      ]
    }, { status: 404 });
  },
};

function handleCORS(request: Request, env: Env): Response {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : DEFAULT_ALLOWED_ORIGINS;
  const safeOrigin = (origin && allowedOrigins.some(o => origin === o || (origin.endsWith(o) && (o.startsWith('.') || origin.length === o.length || origin[origin.length - o.length - 1] === '.'))))
    ? origin
    : allowedOrigins[0] || '';
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': safeOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Secret',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function handleProxy(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return Response.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    const target = new URL(targetUrl);

    // 验证目标主机在白名单中
    if (!ALLOWED_HOSTS.includes(target.host)) {
      return Response.json({ error: 'Host not allowed' }, { status: 403 });
    }

    // 转发请求
    const headers = new Headers();
    headers.set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    headers.set('Accept', 'application/json');
    headers.set('Accept-Language', 'en-US,en;q=0.9');

    // 复制原请求的 Content-Type
    const contentType = request.headers.get('Content-Type');
    if (contentType) {
      headers.set('Content-Type', contentType);
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' ? await request.text() : undefined,
    });

    const data = await response.text();

    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] Upstream error:', msg);
    return Response.json({
      error: 'Proxy error',
      details: msg.slice(0, 200)
    }, { status: 500 });
  }
}

async function handleBinanceCopyTrading(request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || '90D';
  const page = parseInt(url.searchParams.get('page') || '1');

  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading',
      },
      body: JSON.stringify({
        pageNumber: page,
        pageSize: 20,
        timeRange: period,
        dataType: 'ROI',
        favoriteOnly: false,
      }),
    });

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'Binance API error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleBybitCopyTrading(request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || 'DATA_DURATION_NINETY_DAY';
  const pageNo = parseInt(url.searchParams.get('pageNo') || url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '50');

  // Bybit public copy trading API - correct endpoint
  // dataDuration: DATA_DURATION_SEVEN_DAY | DATA_DURATION_THIRTY_DAY | DATA_DURATION_NINETY_DAY
  const periodMap: Record<string, string> = {
    '7': 'DATA_DURATION_SEVEN_DAY',
    '7D': 'DATA_DURATION_SEVEN_DAY',
    '30': 'DATA_DURATION_THIRTY_DAY',
    '30D': 'DATA_DURATION_THIRTY_DAY',
    '90': 'DATA_DURATION_NINETY_DAY',
    '90D': 'DATA_DURATION_NINETY_DAY',
  };

  const dataDuration = periodMap[period] || period;
  // api2.bybit.com bypasses Akamai WAF on www.bybit.com
  const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=${pageSize}&dataDuration=${dataDuration}&sortField=LEADER_SORT_FIELD_SORT_ROI`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.bybit.com/copyTrade',
        'Origin': 'https://www.bybit.com',
      },
    });

    // Check if we got HTML (WAF block) instead of JSON
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (text.includes('Access Denied') || text.includes('<!DOCTYPE') || text.includes('<html')) {
        return Response.json({
          error: 'Bybit API error',
          details: text.slice(0, 200),
          status: response.status,
        }, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
    }

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'Bybit API error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleBitgetCopyTrading(request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || 'THIRTY_DAYS';
  const pageNo = parseInt(url.searchParams.get('pageNo') || url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
  const _type = url.searchParams.get('type') || 'futures'; // futures or spot

  // Period mapping for Bitget V2 API
  const periodMap: Record<string, string> = {
    '7': 'SEVEN_DAYS',
    '7D': 'SEVEN_DAYS',
    '30': 'THIRTY_DAYS',
    '30D': 'THIRTY_DAYS',
    '90': 'NINETY_DAYS',
    '90D': 'NINETY_DAYS',
  };

  const bitgetPeriod = periodMap[period] || period;

  // V1 decommissioned (30032), V2 public return 404
  // These are kept as fallback in case Bitget restores public access
  const endpoints = [
    `https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking?period=${bitgetPeriod}&pageNo=${pageNo}&pageSize=${pageSize}`,
    `https://api.bitget.com/api/v2/copy/mix-trader/query-trader-list?period=${bitgetPeriod}&pageNo=${pageNo}&pageSize=${pageSize}`,
  ];

  for (const apiUrl of endpoints) {
    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.bitget.com/',
          'Origin': 'https://www.bitget.com',
        },
      });

      const contentType = response.headers.get('content-type') || '';
      
      // Skip if we get HTML (CF challenge)
      if (!contentType.includes('application/json')) {
        continue;
      }

      const data = await response.json();
      
      // Check for valid response
      if (data.code === '00000' || data.code === 0 || data.code === '0') {
        return Response.json(data, {
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
      
      // If we get a proper error response (like 40404), try next endpoint
      if (data.code === '40404' || data.msg?.includes('NOT FOUND')) {
        continue;
      }

      // Return whatever we got
      return Response.json(data, {
        headers: { 'Access-Control-Allow-Origin': corsOrigin() },
      });
    } catch (err) {
      console.error(`[proxy] OKX endpoint failed:`, err instanceof Error ? err.message : String(err));
      continue;
    }
  }

  // All endpoints failed
  return Response.json({
    error: 'Bitget API error',
    details: 'Upstream API unavailable',
  }, {
    status: 502,
    headers: { 'Access-Control-Allow-Origin': corsOrigin() },
  });
}

async function handleKuCoinCopyTrading(request: Request, url: URL): Promise<Response> {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '12');

  // KuCoin 跟单 API
  const apiUrl = 'https://www.kucoin.com/_api/copy-trading/future/public/leaderboard';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.kucoin.com',
        'Referer': 'https://www.kucoin.com/copy-trading/leaderboard',
      },
      body: JSON.stringify({
        currentPage: page,
        pageSize: pageSize,
        sortBy: 'ROI',
        sortDirection: 'DESC',
      }),
    });

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'KuCoin API error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleBinanceSpotCopyTrading(request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || '90D';
  const page = parseInt(url.searchParams.get('page') || '1');

  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading/spot',
      },
      body: JSON.stringify({
        pageNumber: page,
        pageSize: 20,
        timeRange: period,
        dataType: 'ROI',
        favoriteOnly: false,
        tradeType: 'SPOT',
      }),
    });

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'Binance Spot API error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// dYdX 代理端点 (绕过地区封锁)
// ============================================

const DYDX_INDEXER = 'https://indexer.dydx.trade';
const DYDX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function handleDydxLeaderboard(request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || 'PERIOD_7D';
  const limit = parseInt(url.searchParams.get('limit') || '100');

  const apiUrl = `${DYDX_INDEXER}/v4/leaderboard/pnl?period=${period}&limit=${limit}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: DYDX_HEADERS,
    });

    const data = await response.json();

    return Response.json(data, {
      status: response.status,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'dYdX leaderboard proxy error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleDydxHistoricalPnl(request: Request, url: URL): Promise<Response> {
  const address = url.searchParams.get('address') || '';
  const subaccountNumber = url.searchParams.get('subaccountNumber') || '0';
  const limit = url.searchParams.get('limit') || '90';

  if (!address) {
    return Response.json({ error: 'Missing address parameter' }, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }

  const apiUrl = `${DYDX_INDEXER}/v4/historical-pnl?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: DYDX_HEADERS,
    });

    const data = await response.json();

    return Response.json(data, {
      status: response.status,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'dYdX historical PnL proxy error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleDydxSubaccount(request: Request, url: URL): Promise<Response> {
  const address = url.searchParams.get('address') || '';
  const subaccountNumber = url.searchParams.get('subaccountNumber') || '0';

  if (!address) {
    return Response.json({ error: 'Missing address parameter' }, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }

  const apiUrl = `${DYDX_INDEXER}/v4/addresses/${address}/subaccounts/${subaccountNumber}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: DYDX_HEADERS,
    });

    const data = await response.json();

    return Response.json(data, {
      status: response.status,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({
      error: 'dYdX subaccount proxy error',
      details: msg.slice(0, 200)
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// MEXC Proxy Endpoint
// ============================================

async function handleMexcCopyTrading(request: Request, url: URL): Promise<Response> {
  const pageSize = parseInt(url.searchParams.get('pageSize') || '50');
  const periodType = parseInt(url.searchParams.get('periodType') || '3');
  const page = parseInt(url.searchParams.get('page') || '1');

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.mexc.com/futures/copyTrade/home',
    'Origin': 'https://www.mexc.com',
  };

  // Strategy 1: GET copyFutures/api/v1/traders/top (simple, no auth)
  try {
    const apiUrl = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/top?limit=${pageSize}`;
    const response = await fetch(apiUrl, { method: 'GET', headers: commonHeaders });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const data = await response.json() as Record<string, unknown>;
      if (response.status === 200 || data.code === 0 || data.success) {
        return Response.json(data, {
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
    }
  } catch (err) {
    console.error(`[proxy] MEXC copyFutures/traders/top failed:`, err instanceof Error ? err.message : String(err));
  }

  // Strategy 2: POST copy-trade/rank/list
  try {
    const apiUrl = 'https://www.mexc.com/api/platform/copy-trade/rank/list';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageNum: page, pageSize, periodType, sortField: 'ROI' }),
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const data = await response.json() as Record<string, unknown>;
      if (response.status === 200 || data.code === 0 || data.success) {
        return Response.json(data, {
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
    }
  } catch (err) {
    console.error(`[proxy] MEXC copy-trade/rank/list failed:`, err instanceof Error ? err.message : String(err));
  }

  // Strategy 3: GET futures.mexc.com copy-trading trader/list
  try {
    const apiUrl = `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list?page=${page}&pageSize=${pageSize}&sortField=yield&sortType=DESC&timeType=${periodType}`;
    const response = await fetch(apiUrl, { method: 'GET', headers: commonHeaders });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const data = await response.json() as Record<string, unknown>;
      if (response.status === 200 || data.code === 0 || data.success) {
        return Response.json(data, {
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
    }
  } catch (err) {
    console.error(`[proxy] MEXC futures trader/list failed:`, err instanceof Error ? err.message : String(err));
  }

  // All endpoints failed
  return Response.json({
    error: 'MEXC API error',
    details: 'All 3 API endpoints failed. Endpoints may have changed.',
    note: 'Please verify current MEXC copy trading API by inspecting Network requests on https://www.mexc.com/futures/copyTrade/home',
  }, {
    status: 502,
    headers: { 'Access-Control-Allow-Origin': corsOrigin() },
  });
}

// ============================================
// HTX (Huobi) Proxy Endpoint
// ============================================

async function handleHtxCopyTrading(request: Request, url: URL): Promise<Response> {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
  const period = url.searchParams.get('period') || '30D';

  // HTX (formerly Huobi) copy trading endpoints to try
  const endpoints = [
    // Current HTX brand
    `https://www.htx.com/v1/copy-trading/public/trader/list?page=${page}&pageSize=${pageSize}&period=${period}`,
    `https://www.htx.com/api/v1/copy-trading/public/traders?page=${page}&pageSize=${pageSize}&period=${period}`,
    // Legacy Huobi endpoints (may still work)
    `https://api.huobi.pro/linear-swap-api/v1/copy-trading/traders?page=${page}&pageSize=${pageSize}`,
    `https://api.hbdm.com/linear-swap-api/v1/copy-trading/traders?page=${page}&pageSize=${pageSize}`,
    // Try contract subdomain
    `https://contract.htx.com/api/v1/copy-trading/public/traders?page=${page}&pageSize=${pageSize}`,
  ];

  for (const apiUrl of endpoints) {
    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.htx.com/',
          'Origin': 'https://www.htx.com',
        },
      });

      const contentType = response.headers.get('content-type') || '';
      
      // Skip if we get HTML (404 or error page)
      if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
        continue;
      }

      const data = await response.json();
      
      // Check for valid response (HTX usually returns status field)
      if (response.status === 200 || data.status === 'ok' || data.code === 200 || data.success) {
        return Response.json(data, {
          headers: { 'Access-Control-Allow-Origin': corsOrigin() },
        });
      }
      
      // If we get a proper error response, try next endpoint
      continue;
    } catch (err) {
      console.error(`[proxy] HTX endpoint failed:`, err instanceof Error ? err.message : String(err));
      continue;
    }
  }

  // All endpoints failed
  return Response.json({
    error: 'HTX API error',
    details: 'All API endpoints returned 404 or invalid responses. HTX may have deprecated copy trading API.',
    note: 'Please verify if HTX still offers copy trading and inspect Network requests on https://www.htx.com/copy-trading',
  }, {
    status: 502,
    headers: { 'Access-Control-Allow-Origin': corsOrigin() },
  });
}

// ============================================
// BingX Proxy Endpoints (bypasses CF block)
// ============================================

const BINGX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://bingx.com/en/CopyTrading/leaderBoard',
  'Origin': 'https://bingx.com',
};

async function handleBingxLeaderboard(_request: Request, url: URL): Promise<Response> {
  const pageIndex = url.searchParams.get('pageIndex') || '1';
  const pageSize  = url.searchParams.get('pageSize')  || '100';
  const timeType  = url.searchParams.get('timeType')  || '2';  // 1=7D 2=30D 3=90D

  // BingX internal leaderboard API
  const apiUrl = `https://api-app.qq-os.com/api/copy-trade-facade/v2/leaderboard/rank?pageIndex=${pageIndex}&pageSize=${pageSize}&timeType=${timeType}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: BINGX_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (_error) {
    // Fallback: try bingx.com API path
    try {
      const fallbackUrl = `https://bingx.com/api/copytrading/v1/leaderboard?pageIndex=${pageIndex}&pageSize=${pageSize}&timeType=${timeType}`;
      const fallbackResp = await fetch(fallbackUrl, { method: 'GET', headers: BINGX_HEADERS });
      const fallbackData = await fallbackResp.text();
      return new Response(fallbackData, {
        status: fallbackResp.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin() },
      });
    } catch (_fallbackError) {
      return Response.json({ error: 'BingX leaderboard proxy error', details: 'Upstream API unavailable' }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': corsOrigin() },
      });
    }
  }
}

async function handleBingxTraderDetail(_request: Request, url: URL): Promise<Response> {
  const uid      = url.searchParams.get('uid') || '';
  const timeType = url.searchParams.get('timeType') || '2';

  if (!uid) {
    return Response.json({ error: 'Missing uid' }, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin() } });
  }

  const apiUrl = `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat?uid=${uid}&timeType=${timeType}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: BINGX_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'BingX trader detail proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleBingxTraderPositions(_request: Request, url: URL): Promise<Response> {
  const uid = url.searchParams.get('uid') || '';

  if (!uid) {
    return Response.json({ error: 'Missing uid' }, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin() } });
  }

  // BingX internal API for current open positions
  const apiUrl = `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/current-position?uid=${uid}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: BINGX_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'BingX trader positions proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// BloFin Proxy Endpoints
// ============================================

const BLOFIN_API = 'https://openapi.blofin.com';
const BLOFIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://blofin.com',
  'Referer': 'https://blofin.com/copy-trade',
};

async function handleBlofinLeaderboard(_request: Request, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || '30';  // 7, 30, 90
  const limit = url.searchParams.get('limit') || '100';

  const apiUrl = `${BLOFIN_API}/api/v1/copytrading/public/leaderboard?period=${period}&limit=${limit}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: BLOFIN_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'BloFin leaderboard proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleBlofinTraderInfo(_request: Request, url: URL): Promise<Response> {
  const uniqueCode = url.searchParams.get('uniqueCode') || '';

  if (!uniqueCode) {
    return Response.json({ error: 'Missing uniqueCode' }, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin() } });
  }

  const apiUrl = `${BLOFIN_API}/api/v1/copytrading/public-lead-traders/detail?uniqueCode=${uniqueCode}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: BLOFIN_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'BloFin trader info proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// Gains Network Proxy Endpoints
// ============================================

const GAINS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

async function handleGainsLeaderboardAll(_request: Request, url: URL): Promise<Response> {
  const chain = url.searchParams.get('chain') || 'arbitrum';  // arbitrum, polygon, base
  const validChains = ['arbitrum', 'polygon', 'base'];
  const safeChain = validChains.includes(chain) ? chain : 'arbitrum';

  const apiUrl = `https://backend-${safeChain}.gains.trade/leaderboard/all`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: GAINS_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'Gains leaderboard proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleGainsOpenTrades(_request: Request, url: URL): Promise<Response> {
  const chain = url.searchParams.get('chain') || 'arbitrum';
  const validChains = ['arbitrum', 'polygon', 'base'];
  const safeChain = validChains.includes(chain) ? chain : 'arbitrum';

  const apiUrl = `https://backend-${safeChain}.gains.trade/open-trades`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: GAINS_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'Gains open-trades proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

async function handleGainsTraderStats(_request: Request, url: URL): Promise<Response> {
  const address = url.searchParams.get('address') || '';
  const chainId = url.searchParams.get('chainId') || '42161';

  if (!address) {
    return Response.json({ error: 'Missing address' }, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin() } });
  }

  const apiUrl = `https://backend-global.gains.trade/api/personal-trading-history/${address}/stats?chainId=${chainId}`;

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers: GAINS_HEADERS });
    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] error:', msg);
    return Response.json({ error: 'Gains trader stats proxy error', details: 'Upstream API unavailable' }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// CoinEx Proxy Endpoint
// ============================================

async function handleCoinexCopyTrading(_request: Request, url: URL): Promise<Response> {
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const sortBy = url.searchParams.get('sortBy') || 'roi';

  const apiUrl = `https://www.coinex.com/res/copy-trading/public/traders?page=${page}&limit=${limit}&sort_by=${sortBy}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.coinex.com/copy-trading',
        'Origin': 'https://www.coinex.com',
      },
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] CoinEx error:', msg);
    return Response.json({
      error: 'CoinEx API error',
      details: msg.slice(0, 200),
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// Gate.io Proxy Endpoint
// ============================================

async function handleGateioCopyTrading(request: Request, url: URL): Promise<Response> {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
  const period = url.searchParams.get('period') || '30D';

  const apiUrl = 'https://www.gate.com/apiw/v2/copy/leader/list';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.gate.com/copy-trading',
        'Origin': 'https://www.gate.com',
      },
      body: request.method === 'POST' ? await request.text() : JSON.stringify({
        page,
        page_size: pageSize,
        period,
        sort_by: 'roi',
        sort_direction: 'desc',
      }),
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] Gate.io error:', msg);
    return Response.json({
      error: 'Gate.io API error',
      details: msg.slice(0, 200),
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// Bitunix Proxy Endpoint (POST)
// ============================================

async function handleBitunixCopyTrading(request: Request, url: URL): Promise<Response> {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '200');
  const period = url.searchParams.get('period') || '30D';

  const apiUrl = 'https://api.bitunix.com/copy/trading/v1/trader/list';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.bitunix.com/copy-trading',
        'Origin': 'https://www.bitunix.com',
      },
      body: request.method === 'POST' ? await request.text() : JSON.stringify({
        page,
        pageSize,
        period,
        sortBy: 'roi',
        sortDirection: 'desc',
      }),
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] Bitunix error:', msg);
    return Response.json({
      error: 'Bitunix API error',
      details: msg.slice(0, 200),
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// Drift DEX Proxy Endpoint
// ============================================

async function handleDriftLeaderboard(_request: Request, url: URL): Promise<Response> {
  const limit = url.searchParams.get('limit') || '500';
  const offset = url.searchParams.get('offset') || '0';
  const orderBy = url.searchParams.get('orderBy') || 'totalPnl';
  const orderDirection = url.searchParams.get('orderDirection') || 'desc';

  const apiUrl = `https://data.api.drift.trade/stats/leaderboard?limit=${limit}&offset=${offset}&orderBy=${orderBy}&orderDirection=${orderDirection}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] Drift error:', msg);
    return Response.json({
      error: 'Drift API error',
      details: msg.slice(0, 200),
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

// ============================================
// Paradex DEX Proxy Endpoint (placeholder)
// ============================================

async function handleParadexLeaderboard(_request: Request, url: URL): Promise<Response> {
  const limit = url.searchParams.get('limit') || '100';
  const period = url.searchParams.get('period') || '30D';

  // Paradex production API endpoint
  const apiUrl = `https://api.prod.paradex.trade/v1/leaderboard?limit=${limit}&period=${period}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proxy] Paradex error:', msg);
    return Response.json({
      error: 'Paradex API error',
      details: msg.slice(0, 200),
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': corsOrigin() },
    });
  }
}

export default worker;
