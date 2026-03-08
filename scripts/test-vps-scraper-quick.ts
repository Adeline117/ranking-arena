#!/usr/bin/env node --no-warnings
/**
 * Quick test for VPS scraper endpoints
 * Tests all supported platforms on VPS
 */

const VPS_URL = process.env.VPS_PROXY_URL || 'http://45.76.152.169:3456';
const VPS_KEY = process.env.VPS_PROXY_KEY || 'arena-proxy-sg-2026';

const TIMEOUT = 60000; // 60s for Playwright scraping

interface TestResult {
  platform: string;
  endpoint: string;
  success: boolean;
  traders: number;
  duration: number;
  error?: string;
  sample?: any;
}

async function testEndpoint(platform: string, endpoint: string, params: Record<string, any>): Promise<TestResult> {
  const start = Date.now();
  const url = new URL(endpoint, VPS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    const res = await fetch(url.toString(), {
      headers: { 'x-proxy-key': VPS_KEY },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - start;

    if (!res.ok) {
      return {
        platform,
        endpoint,
        success: false,
        traders: 0,
        duration,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = await res.json();
    
    // Extract traders from different response formats
    let traders = 0;
    let sample = null;

    if (data.data) {
      if (Array.isArray(data.data)) {
        traders = data.data.length;
        sample = data.data[0];
      } else if (data.data.traderList) {
        traders = data.data.traderList.length;
        sample = data.data.traderList[0];
      } else if (data.data.comprehensives) {
        traders = data.data.comprehensives.length;
        sample = data.data.comprehensives[0];
      } else if (data.data.records) {
        traders = data.data.records.length;
        sample = data.data.records[0];
      } else if (data.data.data) {
        traders = Array.isArray(data.data.data) ? data.data.data.length : 0;
        sample = Array.isArray(data.data.data) ? data.data.data[0] : null;
      }
    }

    return {
      platform,
      endpoint,
      success: traders > 0,
      traders,
      duration,
      sample,
    };
  } catch (err: any) {
    return {
      platform,
      endpoint,
      success: false,
      traders: 0,
      duration: Date.now() - start,
      error: err.message,
    };
  }
}

async function main() {
  console.log('🧪 Testing VPS Scraper Endpoints\n');
  console.log(`VPS: ${VPS_URL}`);
  console.log(`Timeout: ${TIMEOUT}ms\n`);

  const tests: Array<{ platform: string; endpoint: string; params: Record<string, any> }> = [
    { platform: 'bybit', endpoint: '/bybit/leaderboard', params: { pageNo: 1, pageSize: 10, duration: 'DATA_DURATION_THIRTY_DAY' } },
    { platform: 'bitget', endpoint: '/bitget/leaderboard', params: { pageNo: 1, pageSize: 10, period: 'THIRTY_DAYS', type: 'futures' } },
    { platform: 'mexc', endpoint: '/mexc/leaderboard', params: { pageNo: 1, pageSize: 10, periodType: 'THIRTY_DAYS' } },
    { platform: 'coinex', endpoint: '/coinex/leaderboard', params: { pageNo: 1, pageSize: 10, period: 'THIRTY_DAYS' } },
    { platform: 'kucoin', endpoint: '/kucoin/leaderboard', params: { pageNo: 1, pageSize: 10, period: 'THIRTY_DAYS' } },
    { platform: 'gateio', endpoint: '/gateio/leaderboard', params: { pageNo: 1, pageSize: 10, period: 'THIRTY_DAYS' } },
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    process.stdout.write(`Testing ${test.platform}... `);
    const result = await testEndpoint(test.platform, test.endpoint, test.params);
    results.push(result);
    
    if (result.success) {
      console.log(`✅ ${result.traders} traders (${result.duration}ms)`);
    } else {
      console.log(`❌ ${result.error || 'No data'} (${result.duration}ms)`);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`✅ Success: ${results.filter(r => r.success).length}/${results.length}`);
  console.log(`❌ Failed: ${results.filter(r => !r.success).length}/${results.length}`);
  console.log(`⏱️  Avg duration: ${Math.round(results.reduce((sum, r) => sum + r.duration, 0) / results.length)}ms`);

  // Show sample data
  const firstSuccess = results.find(r => r.success);
  if (firstSuccess?.sample) {
    console.log('\n📝 Sample data structure:', JSON.stringify(firstSuccess.sample, null, 2).slice(0, 500));
  }

  process.exit(results.every(r => r.success) ? 0 : 1);
}

main().catch(console.error);
