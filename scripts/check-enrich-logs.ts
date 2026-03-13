import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

const platforms = ['enrich-binance_web3', 'enrich-bingx', 'enrich-bybit', 'enrich-bybit_spot', 'enrich-etoro']

async function main() {
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('task_name, status, created_at, metadata')
    .in('task_name', platforms)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) {
    console.error('Query error:', error)
    process.exit(1)
  }

  console.log(`Found ${data.length} recent logs for problematic platforms:\n`)
  for (const log of data) {
    console.log(`${log.created_at} | ${log.task_name.padEnd(22)} | ${log.status}`)
    if (log.metadata?.reason) {
      console.log(`  Reason: ${log.metadata.reason}`)
    }
    if (log.metadata?.error) {
      console.log(`  Error: ${log.metadata.error}`)
    }
  }
}

main()
