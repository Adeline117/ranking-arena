#!/bin/bash
cd ~/ranking-arena
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { count: wrNull } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).is('win_rate',null);
  if (wrNull > 10000) {
    // WR null 太多，触发充实
    console.log('WR null too high:', wrNull, '- triggering enrichment');
    // 运行关键脚本
  }
})();
" 2>&1
