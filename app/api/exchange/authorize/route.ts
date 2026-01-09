/**
 * 生成交易所授权URL
 * GET /api/exchange/authorize?exchange=binance
 * 
 * 返回授权URL，用户将被重定向到交易所登录页面
 */

import { NextRequest, NextResponse } from 'next/server'

const EXCHANGE_AUTH_URLS: Record<string, string> = {
  binance: 'https://www.binance.com/en/my/settings/api-management',
  bybit: 'https://www.bybit.com/app/user/api-management',
  bitget: 'https://www.bitget.com/zh-CN/user/api',
  mexc: 'https://www.mexc.com/user/api',
  coinex: 'https://www.coinex.com/api',
}

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams
    const exchange = searchParams.get('exchange')
    const userId = searchParams.get('userId') // 用于回调时识别用户

    if (!exchange) {
      return NextResponse.json(
        { error: '缺少参数：exchange' },
        { status: 400 }
      )
    }

    // 获取授权URL
    const authUrl = EXCHANGE_AUTH_URLS[exchange.toLowerCase()]

    if (!authUrl) {
      return NextResponse.json(
        { error: `不支持的交易所: ${exchange}` },
        { status: 400 }
      )
    }

    // 生成state参数（用于防止CSRF攻击）
    const state = Buffer.from(JSON.stringify({
      exchange,
      userId,
      timestamp: Date.now(),
    })).toString('base64')

    // 将state存储到cookie或session中（这里简化处理，实际应该存储到数据库）
    // 重定向到授权页面
    const redirectUrl = new URL('/exchange/authorize/callback', req.nextUrl.origin)
    redirectUrl.searchParams.set('state', state)
    redirectUrl.searchParams.set('exchange', exchange)

    // 对于Binance，我们跳转到API管理页面，用户在那里创建API Key
    // 然后用户需要手动输入API Key和Secret
    // 但我们可以提供一个更好的流程：在新窗口中打开，然后引导用户

    return NextResponse.json({
      authUrl,
      redirectUrl: redirectUrl.toString(),
      exchange,
      instructions: getInstructions(exchange),
    })
  } catch (error: any) {
    console.error('[exchange/authorize] 错误:', error)
    return NextResponse.json(
      { error: error.message || '生成授权URL失败' },
      { status: 500 }
    )
  }
}

function getInstructions(exchange: string): string[] {
  const instructions: Record<string, string[]> = {
    binance: [
      '1. 在新打开的页面中登录您的Binance账号',
      '2. 进入API管理页面，点击"创建API"',
      '3. 选择"系统生成API密钥"',
      '4. 设置API标签（如：Ranking Arena）',
      '5. 完成安全验证',
      '6. 创建成功后，复制API Key和Secret',
      '7. 返回此页面，粘贴API Key和Secret',
      '8. 点击"确认连接"完成绑定',
    ],
    bybit: [
      '1. 在新打开的页面中登录您的Bybit账号',
      '2. 进入API管理页面，创建新的API Key',
      '3. 设置API权限（仅读取权限）',
      '4. 完成安全验证',
      '5. 复制API Key和Secret',
      '6. 返回此页面，粘贴API Key和Secret',
    ],
  }

  return instructions[exchange.toLowerCase()] || [
    '1. 登录您的交易所账号',
    '2. 创建API Key',
    '3. 复制API Key和Secret',
    '4. 返回此页面完成绑定',
  ]
}

