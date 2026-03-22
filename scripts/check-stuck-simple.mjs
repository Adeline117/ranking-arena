#!/usr/bin/env node
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const envPath = join(__dirname, '..', '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch (e) {}
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function check() {
  // 先查看pipeline_logs的schema
  const schemaRes = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_logs?select=*&limit=1`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  })
  
  const sample = await schemaRes.json()
  console.log('Pipeline logs schema sample:')
  console.log(JSON.stringify(sample, null, 2))
  
  // 查询running状态且started_at超过30分钟的任务
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pipeline_logs?select=*&status=eq.running&started_at=lt.${thirtyMinsAgo}`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact'
      }
    }
  )
  
  const count = res.headers.get('content-range')?.split('/')[1]
  const logs = await res.json()
  
  console.log(`\n🔍 Stuck任务数量: ${count}`)
  console.log(`📋 前10条:`)
  console.log(JSON.stringify(logs.slice(0, 10), null, 2))
}

check().catch(console.error)
