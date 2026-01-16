/**
 * AI 翻译 API（带数据库缓存）
 * POST /api/translate - 翻译文本（单个或批量）
 * 
 * 每个帖子/评论只消耗一次 GPT 翻译容量，结果会缓存到数据库
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getSupabaseAdmin, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('translate')

// 计算内容哈希值（用于检测内容变化）
function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

// 单个翻译请求
interface SingleTranslateRequest {
  text: string
  targetLang: 'zh' | 'en'
  contentType?: 'post_title' | 'post_content' | 'comment'
  contentId?: string
}

// 批量翻译请求
interface BatchTranslateRequest {
  items: Array<{
    id: string
    text: string
    contentType: 'post_title' | 'post_content' | 'comment'
    contentId: string
  }>
  targetLang: 'zh' | 'en'
}

// 调用 OpenAI 翻译
async function translateWithGPT(text: string, targetLang: 'zh' | 'en'): Promise<string | null> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  
  if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY not configured')
    return null
  }

  const targetLanguage = targetLang === 'zh' ? '简体中文' : 'English'
  
  try {
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
            content: `You are a professional translator. Translate the following text to ${targetLanguage}. 
Rules:
1. Keep the original meaning and tone
2. Keep all Arabic numerals (0-9) unchanged - do not convert to other numeral systems
3. Keep all punctuation marks unchanged
4. Keep all emoji and emoticons unchanged
5. Only output the translated text without any explanation or additional text`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      logger.error('OpenAI API error', { error: errorData })
      return null
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch (error) {
    logger.error('OpenAI request failed', { error: String(error) })
    return null
  }
}

// 检测源语言
function detectSourceLang(text: string): 'zh' | 'en' {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0
  const totalChars = text.replace(/\s/g, '').length || 1
  return chineseChars / totalChars > 0.1 ? 'zh' : 'en'
}

export async function POST(request: NextRequest) {
  // 限流：每分钟最多 100 次翻译请求
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const body = await request.json()
    const supabase = getSupabaseAdmin()

    // 检查是否是批量请求
    if (body.items && Array.isArray(body.items)) {
      return handleBatchTranslate(body as BatchTranslateRequest, supabase)
    }

    // 单个翻译请求
    return handleSingleTranslate(body as SingleTranslateRequest, supabase)
  } catch (error) {
    logger.error('Translation error', { error: String(error) })
    return NextResponse.json(
      { success: false, error: '翻译服务出错' },
      { status: 500 }
    )
  }
}

// 处理单个翻译
async function handleSingleTranslate(
  { text, targetLang, contentType, contentId }: SingleTranslateRequest,
  supabase: ReturnType<typeof getSupabaseAdmin>
) {
  if (!text || !targetLang) {
    return NextResponse.json(
      { success: false, error: '缺少必要参数' },
      { status: 400 }
    )
  }

  const contentHash = hashContent(text)
  const sourceLang = detectSourceLang(text)

  // 如果源语言和目标语言相同，直接返回原文
  if (sourceLang === targetLang) {
    return NextResponse.json({
      success: true,
      data: {
        translatedText: text,
        originalText: text,
        targetLang,
        cached: true,
        sameLanguage: true,
      }
    })
  }

  // 1. 尝试从缓存获取（如果有 contentType 和 contentId）
  if (contentType && contentId) {
    try {
      const { data: cached } = await supabase
        .from('translation_cache')
        .select('translated_text, content_hash')
        .eq('content_type', contentType)
        .eq('content_id', contentId)
        .eq('target_lang', targetLang)
        .maybeSingle()

      // 如果缓存存在且内容未变化，直接返回
      if (cached && cached.content_hash === contentHash) {
        logger.debug(`Cache hit: ${contentType}/${contentId}`)
        return NextResponse.json({
          success: true,
          data: {
            translatedText: cached.translated_text,
            originalText: text,
            targetLang,
            cached: true,
          }
        })
      }
    } catch (err) {
      logger.warn('Cache query failed', { error: String(err) })
    }
  }

  // 2. 调用 GPT 翻译
  logger.info(`Calling GPT for: ${contentType || 'unknown'}/${contentId || 'none'}`)
  const translatedText = await translateWithGPT(text, targetLang)

  if (!translatedText) {
    return NextResponse.json(
      { success: false, error: '翻译失败' },
      { status: 500 }
    )
  }

  // 3. 保存到缓存（如果有 contentType 和 contentId）
  if (contentType && contentId) {
    try {
      await supabase
        .from('translation_cache')
        .upsert({
          content_type: contentType,
          content_id: contentId,
          content_hash: contentHash,
          source_lang: sourceLang,
          target_lang: targetLang,
          translated_text: translatedText,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'content_type,content_id,target_lang',
        })
      logger.debug(`Cache saved: ${contentType}/${contentId}`)
    } catch (err) {
      logger.warn('Cache save failed', { error: String(err) })
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      translatedText,
      originalText: text,
      targetLang,
      cached: false,
    }
  })
}

// 处理批量翻译
async function handleBatchTranslate(
  { items, targetLang }: BatchTranslateRequest,
  supabase: ReturnType<typeof getSupabaseAdmin>
) {
  if (!items || items.length === 0 || !targetLang) {
    return NextResponse.json(
      { success: false, error: '缺少必要参数' },
      { status: 400 }
    )
  }

  // 限制批量大小
  const limitedItems = items.slice(0, 20)
  const results: Record<string, { translatedText: string; cached: boolean }> = {}

  // 1. 批量查询缓存
  const contentIds = limitedItems.map(item => item.contentId)
  const contentTypes = [...new Set(limitedItems.map(item => item.contentType))]

  // 准备需要翻译的项目列表
  const needsTranslation: typeof limitedItems = []

  // 为每种 contentType 批量查询缓存
  for (const contentType of contentTypes) {
    const idsOfType = limitedItems
      .filter(item => item.contentType === contentType)
      .map(item => item.contentId)

    if (idsOfType.length === 0) continue

    try {
      const { data: cached } = await supabase
        .from('translation_cache')
        .select('content_id, translated_text, content_hash')
        .eq('content_type', contentType)
        .in('content_id', idsOfType)
        .eq('target_lang', targetLang)

      if (cached) {
        const cachedMap = new Map(cached.map(c => [c.content_id, c]))
        
        for (const item of limitedItems.filter(i => i.contentType === contentType)) {
          const cachedItem = cachedMap.get(item.contentId)
          const currentHash = hashContent(item.text)

          if (cachedItem && cachedItem.content_hash === currentHash) {
            // 缓存命中
            results[item.id] = {
              translatedText: cachedItem.translated_text,
              cached: true,
            }
          } else {
            // 需要翻译
            needsTranslation.push(item)
          }
        }
      } else {
        // 没有缓存，全部需要翻译
        needsTranslation.push(...limitedItems.filter(i => i.contentType === contentType))
      }
    } catch (err) {
      logger.warn('Batch cache query failed', { error: String(err) })
      needsTranslation.push(...limitedItems.filter(i => i.contentType === contentType))
    }
  }

  logger.info(`Batch translate: ${limitedItems.length} requests, ${needsTranslation.length} need GPT`)

  // 2. 翻译未缓存的项目（限制并发数）
  const concurrencyLimit = 5
  for (let i = 0; i < needsTranslation.length; i += concurrencyLimit) {
    const batch = needsTranslation.slice(i, i + concurrencyLimit)
    
    await Promise.all(batch.map(async (item) => {
      const sourceLang = detectSourceLang(item.text)
      
      // 如果源语言和目标语言相同
      if (sourceLang === targetLang) {
        results[item.id] = {
          translatedText: item.text,
          cached: true,
        }
        return
      }

      const translatedText = await translateWithGPT(item.text, targetLang)
      
      if (translatedText) {
        results[item.id] = {
          translatedText,
          cached: false,
        }

        // 保存到缓存
        try {
          await supabase
            .from('translation_cache')
            .upsert({
              content_type: item.contentType,
              content_id: item.contentId,
              content_hash: hashContent(item.text),
              source_lang: sourceLang,
              target_lang: targetLang,
              translated_text: translatedText,
              updated_at: new Date().toISOString(),
            }, {
              onConflict: 'content_type,content_id,target_lang',
            })
        } catch (err) {
          logger.warn('Cache save failed', { error: String(err) })
        }
      }
    }))
  }

  return NextResponse.json({
    success: true,
    data: {
      results,
      total: limitedItems.length,
      cached: limitedItems.length - needsTranslation.length,
      translated: needsTranslation.length,
    }
  })
}
