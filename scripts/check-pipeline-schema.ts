import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkSchema() {
  // 先查询一条记录看看schema
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .limit(1)

  if (error) {
    console.error('Error:', error)
    return
  }

  console.log('Pipeline logs schema:')
  console.log(JSON.stringify(data?.[0] || {}, null, 2))
}

checkSchema().catch(console.error)
