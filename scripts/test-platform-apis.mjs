#!/usr/bin/env node
/**
 * Test Platform APIs - Find working endpoints for Bybit, MEXC, HTX
 */

import https from 'https';
import http from 'http';

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

async function testBybit() {
  console.log('\n=== Testing Bybit ===\n');
  
  const endpoints = [
    // V5 API (newer)
    'https://api.bybit.com/v5/copytrading/leaderboard/list?periodType=7&limit=5',
    'https://api.bybit.com/v5/copy-trade/leaderboard?period=7D&limit=5',
    'https://api.bybit.com/v5/copytrading/trader/list?periodType=7&limit=5',
    // V3 API
    'https://api.bybit.com/v3/copy-trade/leader/list?timeWindow=7D&limit=5',
    // Original endpoint
    'https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list?pageNo=0&pageSize=5&sortField=ROI&sortType=DESC&periodType=7',
    // Try futures contract endpoint
    'https://api.bybit.com/contract/v3/public/copytrading/leader/list?limit=5',
  ];
  
  for (const url of endpoints) {
    try {
      console.log(`Testing: ${url}`);
      const res = await fetchJSON(url, {
        headers: {
          'Referer': 'https://www.bybit.com/copyTrading/traderRanking',
          'Origin': 'https://www.bybit.com',
        }
      });
      
      console.log(`  Status: ${res.status}`);
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        console.log(`  Response keys: ${Object.keys(json).join(', ')}`);
        console.log(`  ✅ SUCCESS!`);
        console.log(`  Sample:`, JSON.stringify(json).substring(0, 200));
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
    console.log('');
  }
}

async function testMEXC() {
  console.log('\n=== Testing MEXC ===\n');
  
  const endpoints = [
    // Try different variations
    'https://www.mexc.com/api/platform/copy-trade/trader/list?page=1&pageSize=5&sortBy=roi&sortType=DESC&periodDays=7',
    'https://api.mexc.com/api/v3/copytrading/trader/list?page=1&pageSize=5',
    'https://futures.mexc.com/api/v1/private/copy-trading/leader/list?period=7d&limit=5',
    'https://contract.mexc.com/api/v1/private/copytrading/master/list?limit=5',
  ];
  
  for (const url of endpoints) {
    try {
      console.log(`Testing: ${url}`);
      const res = await fetchJSON(url, {
        headers: {
          'Referer': 'https://www.mexc.com/copy-trading',
          'Origin': 'https://www.mexc.com',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      console.log(`  Status: ${res.status}`);
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        console.log(`  Response keys: ${Object.keys(json).join(', ')}`);
        console.log(`  ✅ SUCCESS!`);
        console.log(`  Sample:`, JSON.stringify(json).substring(0, 200));
      } else if (res.status === 403) {
        console.log(`  ⚠️ 403 Forbidden - WAF protection`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
    console.log('');
  }
}

async function testHTX() {
  console.log('\n=== Testing HTX ===\n');
  
  const endpoints = [
    // Try different API paths
    'https://www.htx.com/v1/copy-trading/public/trader/list?page=1&pageSize=5&sortField=yield_rate&sortOrder=desc&periodDays=7',
    'https://api.htx.com/v1/copytrading/trader/list?page=1&pageSize=5',
    'https://api.huobi.pro/v1/contract/copytrading/leader/list?period=7d&limit=5',
    'https://www.htx.com/api/v1/copytrading/public/leaders?period=7&limit=5',
    'https://www.htx.com/-/x/pro/copy_trade/public/leader/list?period=7&page=1&limit=5',
    'https://www.htx.com/-/x/pro/v2/copy_trade/public/leader/list?period=WEEK&pageNo=1&pageSize=5',
  ];
  
  for (const url of endpoints) {
    try {
      console.log(`Testing: ${url}`);
      const res = await fetchJSON(url, {
        headers: {
          'Referer': 'https://www.htx.com/copy-trading',
          'Origin': 'https://www.htx.com',
        }
      });
      
      console.log(`  Status: ${res.status}`);
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        console.log(`  Response keys: ${Object.keys(json).join(', ')}`);
        console.log(`  ✅ SUCCESS!`);
        console.log(`  Sample:`, JSON.stringify(json).substring(0, 200));
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
    console.log('');
  }
}

async function main() {
  console.log('Arena Platform API Testing');
  console.log('===========================\n');
  
  await testBybit();
  await testMEXC();
  await testHTX();
  
  console.log('\n=== Testing Complete ===');
}

main().catch(console.error);
