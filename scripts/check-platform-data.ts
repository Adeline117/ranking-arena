#!/usr/bin/env tsx
/**
 * 快速检查 Bybit/MEXC/HTX 数据状态
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

config({ path: resolve(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🔍 Checking platform data freshness...\n');

  const platforms = ['bybit', 'mexc', 'htx', 'htx_futures'];

  for (const platform of platforms) {
    const { data, error } = await supabase
      .from('trader_sources')
      .select('source, last_refreshed_at, created_at')
      .eq('source', platform)
      .order('last_refreshed_at', { ascending: false })
      .limit(1);

    if (error) {
      console.log(`❌ ${platform}: Error - ${error.message}`);
      continue;
    }

    if (!data || data.length === 0) {
      console.log(`⚠️  ${platform}: No data found`);
      continue;
    }

    const record = data[0];
    const updatedAt = new Date(record.last_refreshed_at || record.created_at);
    const age = Date.now() - updatedAt.getTime();
    const ageHours = Math.floor(age / (1000 * 60 * 60));
    const ageMinutes = Math.floor((age % (1000 * 60 * 60)) / (1000 * 60));

    const status = ageHours < 6 ? '✅' : ageHours < 24 ? '⚠️ ' : '❌';

    console.log(`${status} ${platform}:`);
    console.log(`   Last updated: ${updatedAt.toISOString()}`);
    console.log(`   Age: ${ageHours}h ${ageMinutes}m`);
    console.log();
  }

  // Count total traders
  const { count: totalCount } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .in('source', platforms);

  console.log(`📊 Total traders in these platforms: ${totalCount || 0}`);
}

main().catch(console.error);
