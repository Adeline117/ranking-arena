
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format') || 'csv'
  const type = searchParams.get('type') || 'traders'

  // 这里应该从数据库获取数据
  // 暂时返回示例数据
  return NextResponse.json({
    message: 'Export endpoint ready',
    format,
    type,
  })
}

