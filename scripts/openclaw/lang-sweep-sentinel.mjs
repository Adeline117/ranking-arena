#!/usr/bin/env node
/**
 * 四语言 UI 点击哨兵 — 常态化固化（QA_HARDENING_PLAN_2026-07 计划 A / A-4）
 *
 * 把两波手工点击审计固化成机判：对一个语言（LANG env / --lang= / 默认 en）跑
 * exhaustive-sweep 的核心路由子集，解析 ledger，把【硬发现】聚合并 Telegram 告警：
 *   - fail:click            真死链/点击失败
 *   - fail:page-error-boundary  页面渲染 error boundary（崩溃）
 *   - http: 5xx             服务端错误
 *   - i18n-leak:*           未翻译的 raw i18n key 渲染成可见文本
 * 【软发现】dead:no-effect（死按钮）与 a11y:contrast（对比度）计数进消息但不 gating
 * ——它们信噪比低/属设计债，靠 artifact + 人工审回归 diff，不 page。
 *
 * 设计为每语言一个进程：GH Actions 用 matrix [en,zh,ja,ko] 并行跑（见
 * .github/workflows/openclaw-sentinels.yml 的 sweep-lang job）。0 硬发现=静默成功
 * （哨兵模型）；有硬发现→exit 1 + 告警；哨兵自身跑不起来→exit 2 + 告警（盲了≠正常）。
 *
 * Requires: TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID（缺则仅打印）。
 * 打生产 https://www.arenafi.org（匿名，只读点击安全）——无需 Supabase 凭证。
 */
import { config } from 'dotenv'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

config({ path: new URL('../../.env.local', import.meta.url).pathname })

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID
const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const LANG =
  (process.argv.find((a) => a.startsWith('--lang=')) || '').split('=')[1] ||
  process.env.LANG_SWEEP ||
  'en'
// Core, high-traffic routes — bounded so 4 langs finish in a daily window.
// Overridable via SWEEP_ROUTES (testing / future tuning).
const CORE_ROUTES =
  process.env.SWEEP_ROUTES || '/,/rankings,/market,/hot,/pricing,/search?q=btc,/flash-news,/learn'

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram disabled]', text)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    })
  } catch (err) {
    console.error('[lang-sweep] telegram send failed:', err.message)
  }
}

function runSweep() {
  const ledgerPath = `/tmp/lang-sweep-${LANG}.jsonl`
  fs.rmSync(ledgerPath, { force: true })
  try {
    // exhaustive-sweep exits 1 on real app errors — that is expected SIGNAL, not
    // a sentinel failure; we parse the ledger regardless. execFileSync throws on
    // non-zero, so swallow and continue to ledger parsing.
    execFileSync(
      'node',
      [
        'scripts/qa/exhaustive-sweep.mjs',
        `--routes=${CORE_ROUTES}`,
        '--max-per-route=60',
        `--lang=${LANG}`,
      ],
      {
        env: { ...process.env, QA_LEDGER: ledgerPath, BASE_URL: BASE },
        stdio: 'inherit',
        timeout: 20 * 60 * 1000,
      }
    )
  } catch {
    // non-zero exit or timeout — fall through; the ledger is the source of truth.
  }
  if (!fs.existsSync(ledgerPath)) return null // sweep never produced a ledger = it couldn't run
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

async function main() {
  console.log(`[lang-sweep] ${LANG} — ${BASE} — routes: ${CORE_ROUTES}`)
  const rows = runSweep()
  if (rows === null) {
    // fail-loud: a blind sentinel is NOT a healthy site (migration-drift lesson)
    console.error(`[lang-sweep] ${LANG}: sweep produced no ledger — sentinel CANNOT verify`)
    await sendTelegram(
      `⚠️ *四语言点击哨兵 [${LANG}] 无法运行*：sweep 未产出 ledger（哨兵盲了 ≠ UI 正常）`
    )
    process.exit(2)
  }

  const hard = []
  const soft = { dead: 0, contrast: 0 }
  for (const r of rows) {
    const st = r.status || ''
    const label = (r.text || r.ariaLabel || r.href || '').slice(0, 30)
    if (st.startsWith('fail:click')) hard.push(`${r.route} fail:click "${label}"`)
    else if (st === 'fail:page-error-boundary') hard.push(`${r.route} error-boundary rendered`)
    else if (st.startsWith('i18n-leak'))
      hard.push(`${r.route} i18n-leak ${JSON.stringify(r.leaks)}`)
    else if ((r.errors || []).some((e) => /http: 5\d\d/.test(e)))
      hard.push(`${r.route} 5xx ${label}`)
    if (st === 'dead:no-effect') soft.dead++
    if (st.startsWith('a11y:contrast')) soft.contrast += (r.contrast || []).length
  }

  const softLine = `soft: dead-button=${soft.dead}, contrast=${soft.contrast}`
  if (hard.length) {
    const msg =
      `🔴 *Arena 四语言点击哨兵 [${LANG}]* — ${hard.length} 硬发现\n` +
      hard
        .slice(0, 20)
        .map((h) => `• ${h}`)
        .join('\n') +
      (hard.length > 20 ? `\n…(+${hard.length - 20})` : '') +
      `\n_${softLine}_`
    console.error(msg)
    await sendTelegram(msg)
    process.exit(1)
  }
  console.log(`✅ [lang-sweep] ${LANG} clean — 0 hard findings. ${softLine}`)
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[lang-sweep] sentinel crashed:', e)
  await sendTelegram(`⚠️ *四语言点击哨兵 [${LANG}] 崩溃*：${String(e.message).slice(0, 200)}`)
  process.exit(2)
})
