/**
 * 测试翻译服务配置
 * GET /api/translate/test
 */

import { NextResponse } from 'next/server'

export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY
  
  return NextResponse.json({
    configured: !!apiKey,
    keyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : null,
    keyLength: apiKey?.length || 0,
    envKeys: Object.keys(process.env).filter(k => 
      k.toLowerCase().includes('openai') || 
      k.toLowerCase().includes('api_key')
    ),
    timestamp: new Date().toISOString(),
  })
}

