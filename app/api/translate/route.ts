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

// Fast translation via Google Translate (free, no API key, ~100ms)
async function translateWithGoogle(text: string, targetLang: 'zh' | 'en'): Promise<string | null> {
  const sourceLang = targetLang === 'zh' ? 'en' : 'zh-CN'
  const target = targetLang === 'zh' ? 'zh-CN' : 'en'
  
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    
    if (!response.ok) return null
    
    const data = await response.json()
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null
    
    // Concatenate all translated segments
    const translated = data[0]
      .filter((segment: unknown[]) => Array.isArray(segment) && segment[0])
      .map((segment: unknown[]) => segment[0])
      .join('')
    
    return translated || null
  } catch (error: unknown) {
    logger.warn('Google Translate failed, falling back to GPT', { error: String(error) })
    return null
  }
}

// 调用 OpenAI 翻译 (fallback, slower but higher quality)
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
  } catch (error: unknown) {
    logger.error('OpenAI request failed', { error: String(error) })
    return null
  }
}

// Try Google first (fast), fallback to GPT (quality)
async function translate(text: string, targetLang: 'zh' | 'en'): Promise<string | null> {
  const googleResult = await translateWithGoogle(text, targetLang)
  if (googleResult) return googleResult
  return translateWithGPT(text, targetLang)
}

// 检测源语言
function detectSourceLang(text: string): 'zh' | 'en' {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0
  const totalChars = text.replace(/\s/g, '').length || 1
  return chineseChars / totalChars > 0.1 ? 'zh' : 'en'
}

export async function POST(request: NextRequest) {
  // 限流：使用敏感操作级别（15/分钟），防止滥用 OpenAI 额度
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
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
  } catch (error: unknown) {
    logger.error('Translation error', { error: String(error) })
    return NextResponse.json(
      { success: false, error: 'Translation service error' },
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
      { success: false, error: 'Missing required parameters' },
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
    } catch (err: unknown) {
      logger.warn('Cache query failed', { error: String(err) })
    }
  }

  // 2. 调用 GPT 翻译
  logger.info(`Calling GPT for: ${contentType || 'unknown'}/${contentId || 'none'}`)
  const translatedText = await translate(text, targetLang)

  if (!translatedText) {
    return NextResponse.json(
      { success: false, error: 'Translation failed' },
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
    } catch (err: unknown) {
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
      { success: false, error: 'Missing required parameters' },
      { status: 400 }
    )
  }

  // 限制批量大小
  const limitedItems = items.slice(0, 20)
  const results: Record<string, { translatedText: string; cached: boolean }> = {}

  // 1. 批量查询缓存
  const _contentIds = limitedItems.map(item => item.contentId)
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
    } catch (err: unknown) {
      logger.warn('Batch cache query failed', { error: String(err) })
      needsTranslation.push(...limitedItems.filter(i => i.contentType === contentType))
    }
  }

  logger.info(`Batch translate: ${limitedItems.length} requests, ${needsTranslation.length} need GPT`)

  // 2. 翻译未缓存的项目（限制并发数，使用错误隔离）
  const concurrencyLimit = 5
  for (let i = 0; i < needsTranslation.length; i += concurrencyLimit) {
    const batch = needsTranslation.slice(i, i + concurrencyLimit)

    // 使用 Promise.allSettled 确保单个翻译失败不会影响其他翻译
    const batchResults = await Promise.allSettled(batch.map(async (item) => {
      const sourceLang = detectSourceLang(item.text)

      // 如果源语言和目标语言相同
      if (sourceLang === targetLang) {
        return { id: item.id, translatedText: item.text, cached: true }
      }

      const translatedText = await translate(item.text, targetLang)

      if (translatedText) {
        // 保存到缓存（不阻塞返回）
        supabase
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
          .then(({ error }) => {
            if (error) logger.warn('Cache save failed', { error: error.message, itemId: item.id })
          })

        return { id: item.id, translatedText, cached: false }
      }

      return { id: item.id, translatedText: null, cached: false }
    }))

    // 处理结果，记录失败的翻译
    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value.translatedText) {
        results[result.value.id] = {
          translatedText: result.value.translatedText,
          cached: result.value.cached,
        }
      } else if (result.status === 'rejected') {
        logger.warn('Translation failed for item', { error: String(result.reason) })
      }
    }
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
