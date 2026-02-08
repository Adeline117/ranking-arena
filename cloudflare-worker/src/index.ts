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

// 支持的交易所 API 白名单
const ALLOWED_HOSTS = [
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
  'api.huobi.pro',
  'api.gmx.io',
  'api.dydx.exchange',
  'api.hyperliquid.xyz',
  // dYdX v4 indexer
  'indexer.dydx.trade',
  'indexer.v4testnet.dydx.exchange',
];

const worker = {

  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // 验证来源
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',');

    if (!allowedOrigins.some(o => origin.includes(o.trim())) && origin !== '') {
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
        '/dydx/leaderboard', '/dydx/historical-pnl', '/dydx/subaccount',
      ]
    }, { status: 404 });
  },
};

function handleCORS(request: Request, _env: Env): Response {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
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
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return Response.json({
      error: 'Proxy error',
      details: error instanceof Error ? error.message : 'Unknown'
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'Binance API error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
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
  const apiUrl = `https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=${pageSize}&dataDuration=${dataDuration}&sortField=LEADER_SORT_FIELD_SORT_ROI`;

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
          details: 'WAF blocked - received HTML instead of JSON. Bybit may be blocking Cloudflare IPs.',
          status: response.status,
        }, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'Bybit API error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
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

  // Try multiple endpoints - Bitget frequently changes their API
  const endpoints = [
    // V2 public endpoints (may return 404)
    `https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking?period=${bitgetPeriod}&pageNo=${pageNo}&pageSize=${pageSize}`,
    `https://api.bitget.com/api/v2/copy/mix-trader/query-trader-list?period=${bitgetPeriod}&pageNo=${pageNo}&pageSize=${pageSize}`,
    // V1 web endpoint (CF protected)
    `https://www.bitget.com/v1/trigger/trace/public/traderViewV3?pageNo=${pageNo}&pageSize=${pageSize}`,
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
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
      
      // If we get a proper error response (like 40404), try next endpoint
      if (data.code === '40404' || data.msg?.includes('NOT FOUND')) {
        continue;
      }

      // Return whatever we got
      return Response.json(data, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    } catch (_err) {
      // Try next endpoint
      continue;
    }
  }

  // All endpoints failed
  return Response.json({
    error: 'Bitget API error',
    details: 'All Bitget API endpoints failed. V1 is deprecated, V2 requires authentication, web endpoints are CF protected.',
    suggestion: 'Consider using authenticated broker API with BITGET_API_KEY',
  }, {
    status: 502,
    headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'KuCoin API error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'Binance Spot API error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'dYdX leaderboard proxy error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'dYdX historical PnL proxy error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

async function handleDydxSubaccount(request: Request, url: URL): Promise<Response> {
  const address = url.searchParams.get('address') || '';
  const subaccountNumber = url.searchParams.get('subaccountNumber') || '0';

  if (!address) {
    return Response.json({ error: 'Missing address parameter' }, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'dYdX subaccount proxy error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export default worker;
