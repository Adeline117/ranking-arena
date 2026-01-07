import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

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
        },
        { status: 500 }
      );
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const now = new Date().toISOString();
    const results: any[] = [];

    // 执行数据抓取脚本
    const scripts = [
      { name: "binance", script: "scripts/import_binance_copy_trading_90d.mjs" },
      { name: "binance_web3", script: "scripts/fetch_binance_web3_all_pages.mjs" },
      { name: "bybit", script: "scripts/import_bybit_90d_roi.mjs" },
      { name: "bitget", script: "scripts/import_bitget_90d_roi.mjs" },
    ];

    for (const { name, script } of scripts) {
      try {
        console.log(`开始执行 ${name} 数据抓取...`);
        const { stdout, stderr } = await execAsync(
          `node ${script}`,
          {
            cwd: process.cwd(),
            timeout: 300000, // 5分钟超时
            env: {
              ...process.env,
              SUPABASE_URL: url,
              SUPABASE_SERVICE_ROLE_KEY: serviceKey,
            },
          }
        );

        results.push({
          name,
          success: true,
          output: stdout.substring(0, 500), // 只保存前500字符
        });
        console.log(`${name} 数据抓取完成`);
      } catch (error: any) {
        results.push({
          name,
          success: false,
          error: error.message || String(error),
        });
        console.error(`${name} 数据抓取失败:`, error.message);
      }
    }

    // 记录执行日志
    try {
      await supabase.from("cron_logs").insert([
        {
          name: "fetch-traders",
          ran_at: now,
          result: JSON.stringify(results),
        },
      ]);
    } catch (error) {
      // 如果 cron_logs 表不存在，忽略错误
      console.warn("Failed to log to cron_logs:", error);
    }

    return NextResponse.json({
      ok: true,
      ran_at: now,
      results,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
