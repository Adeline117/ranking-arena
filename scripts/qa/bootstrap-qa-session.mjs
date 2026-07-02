/**
 * 生成 /tmp/qa-session.json — auth-button-sweep.mjs / exhaustive-sweep.mjs --auth 的前置依赖。
 *
 * 2026-07-01 根治：不再每次运行重置密码（密码重置会吊销 QA 账号全部既存
 * session，杀死并发进程正在使用中的登录态 → 大规模伪 401）。现在走
 * scripts/qa/qa-auth.mjs 的单一通道：持久化密码 password-grant 优先，
 * 仅在登录失败时才于互斥锁内 fallback admin 重置。
 *
 * QA 账号：qa.button.test@arenafi.org（见 memory/qa-test-accounts.md）
 * 用法：node scripts/qa/bootstrap-qa-session.mjs
 */
import fs from 'node:fs'
import { loginQa, readEnv } from './qa-auth.mjs'

const OUT = '/tmp/qa-session.json'

async function main() {
  const SUPA_URL = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const SRK = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  const ANON = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')

  const session = await loginQa({ supaUrl: SUPA_URL, anon: ANON, srk: SRK })
  // 生成时间戳：sweep 的 taint 判定 / 事后审计用（session 对象顶层多余字段
  // 对 Supabase 客户端解析无害）。
  session.qa_bootstrap_at = new Date().toISOString()

  fs.writeFileSync(OUT, JSON.stringify(session, null, 2))
  console.log(
    `✓ ${OUT} created (user ${session.user?.email}, expires_in ${session.expires_in}s, at ${session.qa_bootstrap_at})`
  )
}

main().catch((e) => {
  console.error('✗ bootstrap failed:', e.message)
  process.exit(1)
})
