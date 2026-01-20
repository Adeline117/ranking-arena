/**
 * 交易员详情快速抓取 Cron 端点
 * 
 * GET /api/cron/fetch-details - 健康检查
 * POST /api/cron/fetch-details - 触发快速详情抓取
 * 
 * 参数:
 * - source: 指定来源 (binance, bybit 等)
 * - limit: 限制数量 (默认 200)
 * - concurrency: 并发数 (默认 30)
 * - skipRecent: 跳过最近 N 小时更新的 (默认 6)
 * - force: 强制更新所有 (忽略增量)
 */

import { NextResponse } from 'next/server'
import { isAuthorized, getSupabaseEnv, createSupabaseAdmin, logCronExecution } from '@/lib/cron/utils'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 分钟超时

/**
 * GET - 健康检查
 */
export async function GET() {
  const { url, serviceKey } = getSupabaseEnv()

  return NextResponse.json({
    ok: true,
    message: '详情抓取端点正常',
    script: 'scripts/fetch_details_fast.mjs',
    config: {
      hasSupabaseUrl: !!url,
      hasServiceKey: !!serviceKey,
      hasCronSecret: !!process.env.CRON_SECRET,
    },
  })
}

/**
 * POST - 触发快速详情抓取
 */
export async function POST(req: Request) {
  const startTime = Date.now()
  
  try {
    // 1) 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 2) 验证环境变量
    const { url, serviceKey } = getSupabaseEnv()
    if (!url || !serviceKey) {
      return NextResponse.json(
        {
          error: 'Supabase 环境变量缺失',
          missing: { url: !url, serviceKey: !serviceKey },
        },
        { status: 500 }
      )
    }

    // 3) 解析参数
    const requestUrl = new URL(req.url)
    const source = requestUrl.searchParams.get('source') || ''
    const limit = requestUrl.searchParams.get('limit') || '200'
    const concurrency = requestUrl.searchParams.get('concurrency') || '30'
    const skipRecent = requestUrl.searchParams.get('skipRecent') || '6'
    const force = requestUrl.searchParams.get('force') === 'true'

    // 4) 构建命令
    const args = [
      source ? `--source=${source}` : '',
      `--limit=${limit}`,
      `--concurrency=${concurrency}`,
      `--skip-recent=${skipRecent}`,
      force ? '--force' : '',
    ].filter(Boolean).join(' ')

    const command = `node scripts/fetch_details_fast.mjs ${args}`
    console.log(`[Cron] 执行: ${command}`)

    // 5) 执行脚本
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: 280000, // 280秒超时（留20秒buffer）
      env: {
        ...process.env,
        SUPABASE_URL: url,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
    })

    const duration = Date.now() - startTime
    const output = stdout || stderr

    // 6) 解析输出结果
    const statsMatch = output.match(/成功更新: (\d+)/)
    const totalMatch = output.match(/交易员总数: (\d+)/)
    const success = statsMatch ? parseInt(statsMatch[1]) : 0
    const total = totalMatch ? parseInt(totalMatch[1]) : 0

    // 7) 记录日志
    const supabase = createSupabaseAdmin()
    await logCronExecution(supabase, 'fetch-details-fast', [{
      name: 'fetch_details_fast',
      success: true,
      output: output.substring(0, 1000),
      duration,
    }])

    // 8) 返回结果
    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      summary: {
        total,
        success,
        duration,
        params: { source, limit, concurrency, skipRecent, force },
      },
      output: output.substring(0, 2000),
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Cron] 执行失败:', errorMessage)

    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    )
  }
}
