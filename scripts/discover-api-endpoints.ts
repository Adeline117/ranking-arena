#!/usr/bin/env node --no-warnings
/**
 * API Endpoint Discovery Tool
 * Systematically tests common API patterns for exchanges
 */

interface EndpointTest {
  platform: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

async function testEndpoint(test: EndpointTest): Promise<{ success: boolean; status: number; sample?: any; error?: string }> {
  try {
    const opts: RequestInit = {
      method: test.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...test.headers,
      },
    };

    if (test.body) {
      opts.body = typeof test.body === 'string' ? test.body : JSON.stringify(test.body);
      opts.headers!['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const res = await fetch(test.url, { ...opts, signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        // Check if response contains data
        const hasData = json.data || json.result || json.ranks || json.traders || json.list;
        return {
          success: !!hasData,
          status: res.status,
          sample: hasData ? (json.data || json.result || json) : null,
        };
      } catch {
        return { success: false, status: res.status, error: 'Not JSON' };
      }
    }

    return { success: false, status: res.status };
  } catch (err: any) {
    return { success: false, status: 0, error: err.message };
  }
}

async function discoverOKX() {
  console.log('\n🔍 Discovering OKX API...\n');

  const bases = [
    'https://www.okx.com',
    'https://api.okx.com',
    'https://aws.okx.com',
  ];

  const paths = [
    '/api/v5/copytrading/public/leaders',
    '/api/v5/copytrading/public/leaderboard',
    '/api/v5/rubik/stat/trading-data/copy-trading-leaderboard',
    '/priapi/v5/ecotrade/public/leader-board',
    '/priapi/v5/ecotrade/public/leaderboard',
    '/priapi/v5/copytrading/public/leaders',
    '/v1/copytrading/public/leaders',
    '/public/copytrading/leaderboard',
  ];

  const tests: EndpointTest[] = [];
  for (const base of bases) {
    for (const path of paths) {
      tests.push({
        platform: 'okx',
        url: `${base}${path}?pageNo=1&pageSize=10&sortField=pnlRatio&sortType=desc&period=30D`,
        headers: {
          'Referer': 'https://www.okx.com/copy-trading/leaderboard',
          'Origin': 'https://www.okx.com',
        },
      });
    }
  }

  for (const test of tests) {
    process.stdout.write(`Testing ${test.url.substring(0, 80)}... `);
    const result = await testEndpoint(test);
    if (result.success) {
      console.log(`✅ ${result.status} (FOUND!)`);
      console.log('Sample data:', JSON.stringify(result.sample, null, 2).substring(0, 300));
      return test.url.split('?')[0]; // Return base URL
    } else {
      console.log(`❌ ${result.status} ${result.error || ''}`);
    }
  }

  console.log('\n❌ No working endpoint found for OKX\n');
  return null;
}

async function discoverBinance() {
  console.log('\n🔍 Discovering Binance API...\n');

  const bases = [
    'https://fapi.binance.com',
    'https://api.binance.com',
    'https://www.binance.com',
  ];

  const paths = [
    '/futures/data/leader-board',
    '/futures/data/topTraders',
    '/futures/data/copy-trading/leaderboard',
    '/fapi/v1/copytrading/leaderboard',
    '/api/v3/copytrading/leaderboard',
    '/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    '/bapi/futures/v2/public/future/leaderboard/getLeaderboardRank',
  ];

  for (const base of bases) {
    for (const path of paths) {
      const url = `${base}${path}`;
      process.stdout.write(`Testing ${url.substring(0, 80)}... `);
      const result = await testEndpoint({
        platform: 'binance',
        url,
        method: 'POST',
        body: {
          statisticsType: 'ROI',
          periodType: 'MONTHLY',
          pageNumber: 1,
          pageSize: 10,
        },
      });

      if (result.success) {
        console.log(`✅ ${result.status} (FOUND!)`);
        return url;
      } else {
        console.log(`❌ ${result.status} ${result.error || ''}`);
      }
    }
  }

  console.log('\n❌ No working endpoint found for Binance\n');
  return null;
}

async function discoverKuCoin() {
  console.log('\n🔍 Discovering KuCoin API...\n');

  const bases = [
    'https://www.kucoin.com',
    'https://api.kucoin.com',
    'https://api-futures.kucoin.com',
  ];

  const paths = [
    '/api/v1/copy-trade/public/leaders',
    '/api/v1/copy-trade/leaderboard',
    '/api/v2/copy-trade/public/traders',
    '/api/v3/copytrading/leaderboard',
    '/_api/ucenter/copytrade/public/leaderboard',
    '/_api/futures/copytrade/leaderboard',
  ];

  for (const base of bases) {
    for (const path of paths) {
      const url = `${base}${path}?pageSize=10&currentPage=1&cycle=MONTHLY&sortField=ROI`;
      process.stdout.write(`Testing ${url.substring(0, 80)}... `);
      const result = await testEndpoint({
        platform: 'kucoin',
        url,
        headers: {
          'Referer': 'https://www.kucoin.com/copy-trading',
        },
      });

      if (result.success) {
        console.log(`✅ ${result.status} (FOUND!)`);
        return url.split('?')[0];
      } else {
        console.log(`❌ ${result.status} ${result.error || ''}`);
      }
    }
  }

  console.log('\n❌ No working endpoint found for KuCoin\n');
  return null;
}

async function main() {
  console.log('🔎 API Endpoint Discovery Tool\n');
  console.log('Testing common API patterns for failed platforms...\n');

  const discoveries: Record<string, string | null> = {};

  discoveries.okx = await discoverOKX();
  discoveries.binance = await discoverBinance();
  discoveries.kucoin = await discoverKuCoin();

  console.log('\n📊 Summary:\n');
  Object.entries(discoveries).forEach(([platform, endpoint]) => {
    if (endpoint) {
      console.log(`✅ ${platform}: ${endpoint}`);
    } else {
      console.log(`❌ ${platform}: No endpoint found`);
    }
  });

  // Save results
  const fs = require('fs');
  const output = {
    timestamp: new Date().toISOString(),
    discoveries: Object.fromEntries(
      Object.entries(discoveries).filter(([_, v]) => v !== null)
    ),
  };

  fs.writeFileSync(
    'test-results/api-discoveries.json',
    JSON.stringify(output, null, 2)
  );

  console.log('\n💾 Results saved to test-results/api-discoveries.json\n');
}

main().catch(console.error);
