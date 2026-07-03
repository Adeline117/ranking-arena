#!/usr/bin/env node
/**
 * 备份新鲜度哨兵 — SLO #4（docs/SLO.md）
 *
 * 检查 R2 上最新的 pg_dump 备份是否在 26 小时内（日备 + 2h 容差）。
 * 超阈值 → Telegram 告警。"只备不核"的备份等于没有备份：
 * Mac Mini 的 local-cron-backup 若静默失败，没有这个哨兵就无人知晓。
 *
 * 运行：随 openclaw health monitor crontab 每日跑（或手动 node 执行）。
 * Requires: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *           TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID（缺 Telegram 则仅打印）
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { config } from 'dotenv'

config({ path: new URL('../../.env.local', import.meta.url).pathname })

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-backups'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID

const MAX_AGE_HOURS = 26
// 完整备份(arena+public schema)约 3.9GB；残缺备份(只 public.* 残留表)约 381MB。
// 下限 1GB 捕捉"备份范围退化"(PM-20260703：日备曾漏 arena.* 主数据层)。
const MIN_SIZE_MB = 1024

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
    console.error('[backup-freshness] telegram send failed:', err.message)
  }
}

async function main() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    // fail-loud：哨兵自己不能静默失效（PM-202606-migration-drift 的教训）
    console.error('[backup-freshness] Missing R2 credentials — sentinel CANNOT run')
    await sendTelegram('⚠️ *备份新鲜度哨兵无法运行*：R2 凭证缺失（哨兵盲了 ≠ 备份正常）')
    process.exit(2)
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })

  let newest = null
  let token
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token })
    )
    for (const obj of page.Contents ?? []) {
      if (!obj.Key.endsWith('.sql.gz')) continue
      if (!newest || obj.LastModified > newest.LastModified) newest = obj
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)

  if (!newest) {
    console.error(`🚨 备份缺失：R2 bucket ${R2_BUCKET} 里没有任何 .sql.gz 备份`)
    await sendTelegram(`🚨 *备份缺失*：R2 bucket \`${R2_BUCKET}\` 里没有任何 .sql.gz 备份`)
    process.exit(1)
  }

  const ageHours = (Date.now() - newest.LastModified.getTime()) / 3_600_000
  const sizeMB = newest.Size / 1024 / 1024
  const sizeStr = sizeMB.toFixed(1)
  if (ageHours > MAX_AGE_HOURS) {
    console.error(
      `🚨 备份过期：${newest.Key}（${sizeStr}MB）已 ${ageHours.toFixed(1)}h > ${MAX_AGE_HOURS}h`
    )
    await sendTelegram(
      `🚨 *备份过期*（SLO #4 违约）\n最新备份 \`${newest.Key}\`（${sizeStr}MB）已 ${ageHours.toFixed(1)}h（阈值 ${MAX_AGE_HOURS}h）\n查 Mac Mini local-cron-backup；手动补：\`npm run backup:r2\``
    )
    process.exit(1)
  }
  // 完整性校验：大小骤降 = 备份范围退化（PM-20260703）
  if (sizeMB < MIN_SIZE_MB) {
    console.error(
      `🚨 备份不完整：${newest.Key}（${sizeStr}MB）< ${MIN_SIZE_MB}MB —— 疑范围退化（漏 arena.* 主数据层？）`
    )
    await sendTelegram(
      `🚨 *备份疑范围退化*\n最新备份 \`${newest.Key}\`（${sizeStr}MB）< ${MIN_SIZE_MB}MB 下限\n完整备份应含 arena.* 主数据层（约 3.9GB）。查 backup-db.yml / crontab 的 BACKUP_SCHEMAS。见 PM-20260703。`
    )
    process.exit(1)
  }
  console.log(
    `✅ 备份新鲜且完整：${newest.Key}（${sizeStr}MB，${ageHours.toFixed(1)}h 前）≤ ${MAX_AGE_HOURS}h、≥ ${MIN_SIZE_MB}MB`
  )
}

main().catch(async (err) => {
  console.error('[backup-freshness] check failed:', err)
  await sendTelegram(
    `⚠️ *备份新鲜度哨兵执行失败*：${err.message}（哨兵挂了 ≠ 备份正常，需人工看一眼）`
  )
  process.exit(2)
})
