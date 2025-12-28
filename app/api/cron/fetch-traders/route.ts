import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * 统一鉴权
 * - Vercel Cron 自动触发：会带 x-vercel-cron
 * - 手动 / 本地测试：使用 x-cron-secret
 */
function isAuthorized(req: Request) {
  const vercelCron = req.headers.get("x-vercel-cron");
  if (vercelCron) return true;

  const secret = req.headers.get("x-cron-secret");
  return !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET;
}

/**
 * 实际 cron 逻辑
 */
async function handler(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // === Supabase client（service role）===
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  /**
   * TODO：这里放你真正的逻辑
   * 例如：
   * - 拉交易员数据
   * - 计算 ROI / win rate
   * - upsert 到 traders 表
   */

  // 示例：仅测试数据库是否能连上
  const { error } = await supabase.from("traders").select("id").limit(1);

  if (error) {
    console.error("Supabase error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
  });
}

/**
 * Vercel Cron 默认是 GET
 */
export async function GET(req: Request) {
  return handler(req);
}

/**
 * 手动 curl / 调试用
 */
export async function POST(req: Request) {
  return handler(req);
}