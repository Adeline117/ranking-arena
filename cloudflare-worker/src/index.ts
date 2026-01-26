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
  'www.bitget.com',
  'api.bitget.com',
  'www.mexc.com',
  'api.mexc.com',
  'www.okx.com',
  'api.okx.com',
  'www.kucoin.com',
  'api.kucoin.com',
  'www.coinex.com',
  'api.coinex.com',
  'api.gmx.io',
  'api.dydx.exchange',
  'api.hyperliquid.xyz',
];

export default {
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

    return Response.json({
      error: 'Not found',
      endpoints: ['/health', '/proxy', '/binance/copy-trading', '/binance/spot-copy-trading', '/bybit/copy-trading', '/bitget/copy-trading', '/kucoin/copy-trading']
    }, { status: 404 });
  },
};

function handleCORS(request: Request, env: Env): Response {
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

async function handleProxy(request: Request, env: Env): Promise<Response> {
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
  const period = url.searchParams.get('period') || '90';
  const page = parseInt(url.searchParams.get('page') || '1');

  const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-list`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        pageNo: page,
        pageSize: 20,
        timeRange: period,
        sortField: 'ROI',
        sortType: 'DESC',
      }),
    });

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
  const period = url.searchParams.get('period') || '90';
  const page = parseInt(url.searchParams.get('page') || '1');
  const type = url.searchParams.get('type') || 'futures'; // futures or spot

  const apiPath = type === 'spot' ? 'spot' : 'mix';
  const apiUrl = `https://www.bitget.com/v1/copy/${apiPath}/trader/list?pageNo=${page}&pageSize=20&orderBy=ROI&sortBy=DESC&timeRange=${period}D`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    const data = await response.json();

    return Response.json(data, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return Response.json({
      error: 'Bitget API error',
      details: error instanceof Error ? error.message : 'Unknown'
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
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
