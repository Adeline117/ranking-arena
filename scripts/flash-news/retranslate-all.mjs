#!/usr/bin/env node

/**
 * 批量重新翻译所有 flash_news 标题
 * 使用 OpenAI GPT-4o-mini 进行完整中文翻译
 */

import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
config({ path: join(__dirname, '../..', '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

async function translateBatch(titles) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional crypto/finance news translator. Translate each English news headline to natural, fluent Simplified Chinese. Keep proper nouns like company names, token symbols (BTC, ETH), and abbreviations (SEC, CFTC) as-is. Output ONLY a JSON array of translated strings, in the same order as input. No explanations.`
        },
        {
          role: 'user',
          content: JSON.stringify(titles)
        }
      ],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI API error: ${response.status} ${err}`)
  }

  const data = await response.json()
  const content = data.choices[0].message.content.trim()
  // Parse JSON array from response (handle markdown code blocks)
  const jsonStr = content.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(jsonStr)
}

async function main() {
  console.log('📝 Fetching all flash_news...')
  
  const { data: news, error } = await supabase
    .from('flash_news')
    .select('id, title, title_zh')
    .order('published_at', { ascending: false })

  if (error) {
    console.error('DB error:', error)
    process.exit(1)
  }

  console.log(`Found ${news.length} records`)

  // Process in batches of 10
  const BATCH_SIZE = 10
  let updated = 0

  for (let i = 0; i < news.length; i += BATCH_SIZE) {
    const batch = news.slice(i, i + BATCH_SIZE)
    const titles = batch.map(n => n.title)
    
    console.log(`\nTranslating batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(news.length/BATCH_SIZE)}...`)
    
    try {
      const translations = await translateBatch(titles)
      
      for (let j = 0; j < batch.length; j++) {
        const translated = translations[j]
        if (!translated) continue
        
        const { error: updateError } = await supabase
          .from('flash_news')
          .update({ title_zh: translated })
          .eq('id', batch[j].id)

        if (updateError) {
          console.error(`  ✗ Failed to update ${batch[j].id}:`, updateError.message)
        } else {
          console.log(`  ✓ "${batch[j].title.substring(0, 50)}..." → "${translated}"`)
          updated++
        }
      }
    } catch (err) {
      console.error(`  ✗ Batch translation failed:`, err.message)
      // Fallback: translate one by one
      for (const item of batch) {
        try {
          const [single] = await translateBatch([item.title])
          if (single) {
            await supabase.from('flash_news').update({ title_zh: single }).eq('id', item.id)
            console.log(`  ✓ (single) "${item.title.substring(0, 40)}..." → "${single}"`)
            updated++
          }
        } catch (e) {
          console.error(`  ✗ Single translation failed for ${item.id}:`, e.message)
        }
      }
    }
    
    // Rate limit
    if (i + BATCH_SIZE < news.length) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  console.log(`\n✅ Done! Updated ${updated}/${news.length} records`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
