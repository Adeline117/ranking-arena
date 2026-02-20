import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Check table schema
const { data, error } = await sb.from('leaderboard_ranks').select('*').limit(1)
if (error) console.error('Error:', error.message)
else if (data?.length) console.log('Columns:', Object.keys(data[0]))
else console.log('No rows found')
