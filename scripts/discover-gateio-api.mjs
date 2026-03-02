#!/usr/bin/env node

/**
 * Gate.io API Discovery Script
 * Attempts to find working public endpoints for copy trade data
 */

import https from 'https';

const BASE_URL = 'api.gateio.ws';
const endpoints = [
  '/api/v4/copytrade/traders',
  '/api/v4/copytrade/leaderboard',
  '/api/v4/copytrade/strategies',
  '/api/v4/futures/copytrade/traders',
  '/api/v4/futures/copy_trading/traders',
];

async function testEndpoint(path, params = '') {
  return new Promise((resolve) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const fullPath = params ? `${path}?${params}` : path;
    
    const options = {
      hostname: BASE_URL,
      path: fullPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Timestamp': timestamp.toString(),
      }
    };

    console.log(`\n🔍 Testing: ${BASE_URL}${fullPath}`);
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`   Status: ${res.statusCode}`);
        try {
          const json = JSON.parse(data);
          console.log(`   Response:`, JSON.stringify(json, null, 2).substring(0, 200));
          resolve({ path: fullPath, status: res.statusCode, data: json });
        } catch (e) {
          console.log(`   Response (not JSON):`, data.substring(0, 200));
          resolve({ path: fullPath, status: res.statusCode, data });
        }
      });
    });

    req.on('error', (e) => {
      console.log(`   Error: ${e.message}`);
      resolve({ path: fullPath, error: e.message });
    });

    req.end();
  });
}

async function main() {
  console.log('🚀 Gate.io API Discovery\n');
  console.log('=' .repeat(60));
  
  const results = [];
  
  // Test basic endpoints
  for (const endpoint of endpoints) {
    const result = await testEndpoint(endpoint, 'limit=5');
    results.push(result);
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }
  
  // Try without authentication headers
  console.log('\n\n🔓 Testing without Timestamp header...\n');
  const noAuthResult = await new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path: '/api/v4/copytrade/traders?limit=5',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          console.log('   Response:', JSON.parse(data));
        } catch (e) {
          console.log('   Response:', data);
        }
        resolve();
      });
    });
    
    req.on('error', (e) => {
      console.log('   Error:', e.message);
      resolve();
    });
    
    req.end();
  });
  
  console.log('\n\n' + '='.repeat(60));
  console.log('📝 Summary:');
  console.log('All tested endpoints require API KEY authentication');
  console.log('Gate.io copytrade data is not publicly accessible via API');
  console.log('\nNext steps:');
  console.log('1. User needs to provide Gate.io API credentials');
  console.log('2. Or: Use browser automation to scrape the website');
  console.log('='.repeat(60));
}

main().catch(console.error);
