import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * We support BOTH naming styles:
 * - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only)
 * - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (your current Vercel setup)
 */
function getSupabaseEnv() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  return { url, serviceKey };
}

function isAuthorized(req: Request) {
  const header = req.headers.get("x-cron-secret") || "";
  const secret = process.env.CRON_SECRET || "";
  return Boolean(secret) && header === secret;
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "cron endpoint alive" });
}

export async function POST(req: Request) {
  try {
    // 1) auth
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // 2) env
    const { url, serviceKey } = getSupabaseEnv();
    if (!url || !serviceKey) {
      return NextResponse.json(
        {
          error: "Supabase env missing",
          missing: {
            url: !url,
            serviceKey: !serviceKey,
          },
          expected: [
            "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
          ],
          found: {
            SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
            NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
            SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
          },
        },
        { status: 500 }
      );
    }

    // 3) client (service role)
    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    /**
     * TODO: 这里放你真正的“抓 traders + 写入 supabase”的逻辑
     * 我先给你一个最小写入测试：写一条 heartbeat 到 cron_logs 表
     * 你如果还没建表，会返回一个清晰的错误信息。
     */
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("cron_logs")
      .insert([{ name: "fetch-traders", ran_at: now }]);

    if (error) {
      return NextResponse.json(
        { ok: false, step: "insert cron_logs", supabaseError: error },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, inserted: 1, at: now });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
