#!/usr/bin/env node
/**
 * Test API endpoints for onchain platforms
 * Quick validation before running full enrichment
 */

import fetch from 'node-fetch';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function testHyperliquid() {
  console.log('\n=== Testing Hyperliquid API ===');
  try {
    // Use a known active trader address
    const testAddress = '0x010461C14e146ac35Fe42271BDC1134EE31B725a'; // Example from leaderboard
    
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFills',
        user: testAddress
      })
    });
    
    const data = await resp.json();
    console.log(`✓ Hyperliquid API working`);
    console.log(`  Sample response:`, Array.isArray(data) ? `${data.length} fills` : 'structure:', Object.keys(data));
    return true;
  } catch (error) {
    console.log(`✗ Hyperliquid API failed: ${error.message}`);
    return false;
  }
}

async function testAevo() {
  console.log('\n=== Testing Aevo API ===');
  try {
    const testAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'; // Example
    const resp = await fetch(`https://api.aevo.xyz/statistics?account=${testAddress}`);
    
    if (resp.ok) {
      const data = await resp.json();
      console.log(`✓ Aevo API working`);
      console.log(`  Sample response:`, Object.keys(data));
      return true;
    } else {
      console.log(`✗ Aevo API returned ${resp.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ Aevo API failed: ${error.message}`);
    return false;
  }
}

async function testDydx() {
  console.log('\n=== Testing dYdX API ===');
  try {
    // Try the indexer API
    const testAddress = 'dydx1...'; // Need actual dYdX address
    const resp = await fetch(`https://indexer.dydx.trade/v4/fills?limit=10`);
    
    if (resp.ok) {
      const data = await resp.json();
      console.log(`✓ dYdX Indexer API working`);
      console.log(`  Sample response:`, Object.keys(data));
      return true;
    } else {
      console.log(`✗ dYdX API returned ${resp.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ dYdX API failed: ${error.message}`);
    return false;
  }
}

async function testDrift() {
  console.log('\n=== Testing Drift API ===');
  try {
    // Drift API base
    const resp = await fetch('https://api.drift.trade/users');
    
    if (resp.ok) {
      console.log(`✓ Drift API responding`);
      return true;
    } else {
      console.log(`⚠ Drift API returned ${resp.status} - may need specific user address`);
      return false;
    }
  } catch (error) {
    console.log(`✗ Drift API failed: ${error.message}`);
    return false;
  }
}

async function testJupiterPerps() {
  console.log('\n=== Testing Jupiter Perps API ===');
  try {
    // Try the stats API
    const resp = await fetch('https://stats-api.jup.ag/perps/stats');
    
    if (resp.ok) {
      console.log(`✓ Jupiter Perps API responding`);
      return true;
    } else {
      console.log(`⚠ Jupiter Perps API returned ${resp.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ Jupiter Perps API failed: ${error.message}`);
    return false;
  }
}

async function testGains() {
  console.log('\n=== Testing Gains Network (The Graph) ===');
  try {
    const query = `
      query {
        traders(first: 1) {
          id
          winRate
        }
      }
    `;
    
    const resp = await fetch('https://api.thegraph.com/subgraphs/name/gainsnetwork/gtrade-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    
    if (resp.ok) {
      const data = await resp.json();
      console.log(`✓ Gains Network subgraph working`);
      console.log(`  Sample:`, data.data?.traders?.[0] || 'No data');
      return true;
    } else {
      console.log(`✗ Gains Network returned ${resp.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ Gains Network failed: ${error.message}`);
    return false;
  }
}

async function testGMX() {
  console.log('\n=== Testing GMX (The Graph) ===');
  try {
    const query = `
      query {
        users(first: 1) {
          id
          closedPositionCount
        }
      }
    `;
    
    const resp = await fetch('https://api.thegraph.com/subgraphs/name/gmx-io/gmx-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    
    if (resp.ok) {
      const data = await resp.json();
      console.log(`✓ GMX subgraph working`);
      console.log(`  Sample:`, data.data?.users?.[0] || 'No data');
      return true;
    } else {
      console.log(`✗ GMX returned ${resp.status}`);
      return false;
    }
  } catch (error) {
    console.log(`✗ GMX failed: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('Testing all Onchain Platform APIs...\n');
  
  const results = [];
  
  results.push(['Hyperliquid', await testHyperliquid()]);
  await sleep(1000);
  
  results.push(['Aevo', await testAevo()]);
  await sleep(1000);
  
  results.push(['dYdX', await testDydx()]);
  await sleep(1000);
  
  results.push(['Drift', await testDrift()]);
  await sleep(1000);
  
  results.push(['Jupiter Perps', await testJupiterPerps()]);
  await sleep(1000);
  
  results.push(['Gains Network', await testGains()]);
  await sleep(1000);
  
  results.push(['GMX', await testGMX()]);
  
  console.log('\n' + '='.repeat(50));
  console.log('Summary:');
  console.log('='.repeat(50));
  
  for (const [name, success] of results) {
    console.log(`${success ? '✓' : '✗'} ${name.padEnd(20)} ${success ? 'OK' : 'FAILED'}`);
  }
  
  const successCount = results.filter(([, s]) => s).length;
  console.log(`\n${successCount}/${results.length} APIs working`);
}

main();
