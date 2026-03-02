import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { data, error } = await sb
  .from('traders')
  .select('*')
  .eq('platform', 'gateio')
  .limit(1)

if (error) {
  console.error('Error:', error)
} else {
  console.log('Columns:', Object.keys(data[0] || {}))
  console.log('\nSample:', data[0])
}
