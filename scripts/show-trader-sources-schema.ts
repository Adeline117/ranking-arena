#!/usr/bin/env tsx
import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

config({ path: resolve(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data, error } = await supabase
    .from('trader_sources')
    .select('*')
    .in('source', ['bybit', 'mexc', 'htx'])
    .limit(1);

  if (error) {
    console.error('Error:', error);
    return;
  }

  if (data && data.length > 0) {
    console.log('Columns in trader_sources table:');
    console.log(Object.keys(data[0]));
    console.log('\nSample record:');
    console.log(JSON.stringify(data[0], null, 2));
  } else {
    console.log('No data found');
  }
}

main();
