/**
 * OpenAPI 文档端点
 * GET /api/docs - 返回 OpenAPI 规范 JSON
 */

import { NextResponse } from 'next/server'
import { createRankingArenaOpenAPI } from '@/lib/api/openapi-generator'

// 缓存生成的文档
let cachedSpec: string | null = null

export async function GET() {
  // 使用缓存
  if (!cachedSpec) {
    const generator = createRankingArenaOpenAPI()
    cachedSpec = generator.toJSON()
  }

  return new NextResponse(cachedSpec, {
    headers: {
      'Content-Type': 'application/json',
      // 缓存 1 小时
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
