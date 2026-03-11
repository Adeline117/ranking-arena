#!/usr/bin/env tsx
/**
 * Test a single platform connector
 * Usage: npx tsx scripts/test-single-platform.ts <platform> <market_type> <window> <limit>
 * Example: npx tsx scripts/test-single-platform.ts bitget futures 30d 5
 */

import 'dotenv/config';
import { getConnector } from '../connectors/index.js';
import type { Platform, MarketType, Window } from '../connectors/base/types.js';

async function main() {
  const platform = (process.argv[2] || 'bitget') as Platform;
  const market_type = (process.argv[3] || 'futures') as MarketType;
  const window = (process.argv[4] || '30d') as Window;
  const limit = parseInt(process.argv[5] || '5');

  console.log(`\n🧪 Testing ${platform}:${market_type} (window=${window}, limit=${limit})\n`);

  const connector = getConnector(platform, market_type);

  if (!connector) {
    console.error(`❌ No connector found for ${platform}:${market_type}`);
    process.exit(1);
  }

  try {
    const result = await connector.discoverLeaderboard(window, limit);
    
    console.log(`Success: ${result.success}`);
    console.log(`Data count: ${result.data?.length || 0}`);
    
    if (result.success && result.data) {
      console.log(`\n✅ First trader:`);
      console.log(JSON.stringify(result.data[0], null, 2));
    } else {
      console.log(`\n❌ Error: ${result.error}`);
      console.log(`Quality flags: ${JSON.stringify(result.quality_flags)}`);
    }
  } catch (error) {
    console.error(`\n❌ Exception:`, error);
    process.exit(1);
  }
}

main().catch(console.error);
