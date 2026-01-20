/**
 * 测试 Binance API 访问
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        pageNumber: 1,
        pageSize: 5,
        timeRange: '90D',
        dataType: 'ROI',
        favoriteOnly: false,
      }),
    })
    
    const data = await response.json()
    
    // 检查是否有头像数据
    const list = data?.data?.list || []
    const avatarInfo = list.map((t: { nickName?: string; userPhoto?: string }) => ({
      name: t.nickName,
      avatar: t.userPhoto ? t.userPhoto.substring(0, 50) + '...' : null,
    }))
    
    return NextResponse.json({
      status: response.status,
      hasData: list.length > 0,
      traderCount: list.length,
      avatarInfo,
      rawResponse: data?.code !== undefined ? { code: data.code, msg: data.msg } : null,
    })
  } catch (error) {
    return NextResponse.json({
      error: String(error),
    }, { status: 500 })
  }
}
