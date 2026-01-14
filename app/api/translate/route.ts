/**
 * AI 翻译 API
 * POST /api/translate - 翻译文本
 */

import { NextRequest, NextResponse } from 'next/server'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { text, targetLang } = body

    if (!text || !targetLang) {
      return NextResponse.json(
        { success: false, error: '缺少必要参数' },
        { status: 400 }
      )
    }

    // 如果没有配置 OpenAI API Key，返回错误
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { success: false, error: '翻译服务未配置' },
        { status: 503 }
      )
    }

    const targetLanguage = targetLang === 'zh' ? '简体中文' : 'English'
    
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
            content: `You are a professional translator. Translate the following text to ${targetLanguage}. Keep the original meaning and tone. Only output the translated text without any explanation or additional text.`
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
      console.error('[translate] OpenAI API error:', errorData)
      return NextResponse.json(
        { success: false, error: '翻译失败' },
        { status: 500 }
      )
    }

    const data = await response.json()
    const translatedText = data.choices?.[0]?.message?.content?.trim()

    if (!translatedText) {
      return NextResponse.json(
        { success: false, error: '翻译结果为空' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: {
        translatedText,
        originalText: text,
        targetLang,
      }
    })
  } catch (error) {
    console.error('[translate] Error:', error)
    return NextResponse.json(
      { success: false, error: '翻译服务出错' },
      { status: 500 }
    )
  }
}

