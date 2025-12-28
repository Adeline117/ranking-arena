import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"

/**
 * Health check / manual ping
 */
export async function GET() {
  return NextResponse.json({ ok: true, message: "cron endpoint alive" })
}

/**
 * Cron / secured trigger
 */
export async function POST(req: Request) {
  try {
    // 1️⃣ 校验 cron secret
    const headerSecret = req.headers.get("x-cron-secret")
    const envSecret = process.env.CRON_SECRET

    if (!envSecret) {
      return NextResponse.json(
        { error: "CRON_SECRET not configured on server" },
        { status: 500 }
      )
    }

    if (headerSecret !== envSecret) {
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401 }
      )
    }

    // 2️⃣ 校验 Supabase env
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Supabase env missing" },
        { status: 500 }
      )
    }

    // 3️⃣ 创建 Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey)

    // ⚠️ 这里先只做一个最安全的测试查询
    // 后面你再加真实 fetch / update 逻辑
    const { data, error } = await supabase
      .from("traders")
      .select("id")
      .limit(1)

    if (error) {
      return NextResponse.json(
        { error: "supabase query failed", detail: error.message },
        { status: 500 }
      )
    }

    // 4️⃣ 成功返回
    return NextResponse.json({
      ok: true,
      message: "cron executed successfully",
      sample: data,
    })
  } catch (err: any) {
    // 🚨 最外层兜底，防止 500 无信息
    return NextResponse.json(
      {
        error: "unexpected crash",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    )
  }
}