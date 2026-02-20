import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Check seasons
const { data: seasons } = await sb.from('seasons').select('id, name, slug, is_active').order('id', { ascending: false }).limit(10)
console.log('Seasons:', JSON.stringify(seasons, null, 2))
