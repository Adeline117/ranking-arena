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
      // Binance 多时间段排行榜抓取
      { name: "binance_7d", script: "scripts/import_binance_copy_trading_90d.mjs", args: ["7D"] },
      { name: "binance_30d", script: "scripts/import_binance_copy_trading_90d.mjs", args: ["30D"] },
      { name: "binance_90d", script: "scripts/import_binance_copy_trading_90d.mjs", args: ["90D"] },
      // Binance 交易员详情页抓取
      { name: "binance_details", script: "scripts/fetch_binance_trader_details.mjs", args: [] },
      // Binance Web3 多时间段排行榜抓取
      { name: "binance_web3_7d", script: "scripts/fetch_binance_web3_all_pages.mjs", args: ["7D"] },
      { name: "binance_web3_30d", script: "scripts/fetch_binance_web3_all_pages.mjs", args: ["30D"] },
      { name: "binance_web3_90d", script: "scripts/fetch_binance_web3_all_pages.mjs", args: ["90D"] },
      // Binance Web3 交易员详情页抓取
      { name: "binance_web3_details", script: "scripts/fetch_binance_web3_trader_details.mjs", args: [] },
      // Bybit 多时间段排行榜抓取
      { name: "bybit_7d", script: "scripts/import_bybit_90d_roi.mjs", args: ["7D"] },
      { name: "bybit_30d", script: "scripts/import_bybit_90d_roi.mjs", args: ["30D"] },
      { name: "bybit_90d", script: "scripts/import_bybit_90d_roi.mjs", args: ["90D"] },
      // Bybit 交易员详情页抓取
      { name: "bybit_details", script: "scripts/fetch_bybit_trader_details.mjs", args: [] },
      // 其他数据源
      { name: "bitget", script: "scripts/import_bitget_90d_roi.mjs", args: [] },
      { name: "mexc", script: "scripts/import_mexc_90d_roi.mjs", args: [] },
      { name: "coinex", script: "scripts/import_coinex_90d_roi.mjs", args: [] },
      { name: "okx", script: "scripts/import_okx_90d_roi.mjs", args: [] },
      { name: "kucoin", script: "scripts/import_kucoin_90d_roi.mjs", args: [] },
      { name: "gate", script: "scripts/import_gate_90d_roi.mjs", args: [] },
    ];

    for (const { name, script, args = [] } of scripts) {
      try {
        console.log(`开始执行 ${name} 数据抓取...`);
        const command = `node ${script}${args.length > 0 ? ` ${args.join(' ')}` : ''}`
        const { stdout } = await execAsync(
          command,
          {
            cwd: process.cwd(),
            timeout: 300000, // 5分钟超时（详情页抓取可能需要更长时间）
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
