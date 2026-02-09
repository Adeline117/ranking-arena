#!/bin/bash
# Run MEXC nickname backfill from VPS (bypasses geo-blocking)
# Usage: ssh root@45.76.152.169 'bash -s' < scripts/backfill-mexc-from-vps.sh

set -e

# Install node if not present
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

cat << 'SCRIPT' > /tmp/backfill-mexc.mjs
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Get all MEXC traders with numeric handles
async function getBadTraders() {
  const traders = []
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'mexc')
      .range(from, from + 999)
    if (!data || !data.length) break
    for (const d of data) {
      if (d.handle === d.source_trader_id || /^Mexctrader-/.test(d.handle)) {
        traders.push(d)
      }
    }
    from += 1000
    if (data.length < 1000) break
  }
  return traders
}

async function fetchNickname(traderId) {
  try {
    const url = `https://www.mexc.com/api/platform/copy-trade/trader/detail?traderId=${traderId}`
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.mexc.com', Referer: 'https://www.mexc.com/copy-trading' }
    })
    if (!resp.ok) return null
    const data = await resp.json()
    return {
      nickname: data?.data?.nickName || null,
      avatar: data?.data?.avatar || null,
    }
  } catch { return null }
}

async function main() {
  const traders = await getBadTraders()
  console.log(`Found ${traders.length} MEXC traders to fix`)
  
  let updated = 0, failed = 0
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const result = await fetchNickname(t.source_trader_id)
    
    if (result?.nickname && result.nickname !== t.handle) {
      const update = { handle: result.nickname }
      if (result.avatar) update.avatar_url = result.avatar
      
      const { error } = await supabase.from('trader_sources')
        .update(update).eq('id', t.id)
      
      if (!error) {
        updated++
        if (updated <= 10 || updated % 100 === 0)
          console.log(`[${i+1}/${traders.length}] ${t.handle} → ${result.nickname}`)
      } else failed++
    } else failed++
    
    if (i > 20 && failed > updated * 3) {
      console.log('Too many failures, API might be blocked. Stopping.')
      break
    }
    
    await sleep(2000 + Math.random() * 1000)
  }
  
  console.log(`Done: ${updated} updated, ${failed} failed`)
}

main()
SCRIPT

node --experimental-network-imports /tmp/backfill-mexc.mjs 2>&1 || {
  # Fallback: use npm directly
  cd /tmp
  npm init -y 2>/dev/null
  npm install @supabase/supabase-js 2>/dev/null
  
  cat << 'FALLBACK' > /tmp/backfill-mexc-fb.mjs
const { createClient } = await import('@supabase/supabase-js')
// ... same code but with import from node_modules
FALLBACK
  
  echo "ESM import failed. Try manual installation on VPS."
}
