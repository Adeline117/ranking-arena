#!/usr/bin/env node
/**
 * 备份新鲜度哨兵 — SLO #4（docs/SLO.md）
 *
 * R2 LIST 只用于从共享 backup/restore 文件名 contract 中选出最新候选；
 * 最终健康判定必须来自该对象的 HEAD 元数据。这样任意 .sql.gz、旧 partial
 * 文件或只有列表大小/时间的对象都不能把哨兵变成 false-green。
 */
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from 'dotenv'

import {
  arenaCompletionTokenFromMetadata,
  assertCompleteBackupObject,
  COMPLETE_BACKUP_MIN_BYTES,
  parseCompleteBackupKey,
} from '../maintenance/backup-restore-contract.mjs'

config({ path: fileURLToPath(new URL('../../.env.local', import.meta.url)), quiet: true })

export const MAX_BACKUP_AGE_HOURS = 26
const BACKUP_PREFIX = 'db-backups/'
const HOURS_TO_MS = 60 * 60 * 1000

function completeIdentityFromKey(key) {
  return parseCompleteBackupKey(key)
}

function validDateMillis(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function freshnessViolation(message, alertText) {
  const error = new Error(message)
  error.name = 'BackupFreshnessViolation'
  error.exitCode = 1
  error.alertText = alertText
  return error
}

function sentinelFailure(message, alertText) {
  const error = new Error(message)
  error.name = 'BackupFreshnessSentinelFailure'
  error.exitCode = 2
  error.alertText = alertText
  return error
}

/**
 * Validate the authoritative HEAD result for one shared-contract backup key.
 * The completion token is mandatory here even though restore retains a narrower
 * evidence-based path for pre-contract artifacts: freshness must prove that the
 * current producer completed, not merely that an old object may be restorable.
 */
export function assertFreshBackupHead(key, head) {
  const identity = completeIdentityFromKey(key)
  if (!identity) {
    throw new Error('object key is not a complete schemas/full backup')
  }

  const object = assertCompleteBackupObject({
    Key: key,
    Size: head?.ContentLength,
    ETag: head?.ETag,
    Metadata: head?.Metadata,
  })
  if (head.ContentType !== 'application/gzip') {
    throw new Error('HEAD ContentType must be application/gzip')
  }

  let completionToken
  try {
    completionToken = arenaCompletionTokenFromMetadata(head.Metadata)
  } catch (error) {
    throw new Error(`completion metadata is invalid: ${error.message}`)
  }
  if (completionToken === undefined) {
    throw new Error('completion-contract and completion-token metadata are required')
  }

  const backupDateValue = Object.entries(head.Metadata ?? {}).find(
    ([name]) => name.toLowerCase() === 'backup-date'
  )?.[1]
  const backupDate = new Date(String(backupDateValue ?? ''))
  if (!Number.isFinite(backupDate.getTime()) || backupDate.toISOString() !== backupDateValue) {
    throw new Error('backup-date metadata must be a canonical UTC timestamp')
  }
  const backupUtcDate = backupDate.toISOString().slice(0, 10).replaceAll('-', '')
  if (backupUtcDate !== identity.date) {
    throw new Error(
      `backup-date UTC date ${backupUtcDate} does not match key UTC date ${identity.date}`
    )
  }

  return {
    Key: key,
    Size: object.Size,
    ETag: object.ETag,
    Metadata: head.Metadata,
    backupDate,
    completionToken,
    mode: identity.mode,
  }
}

/** LIST is selection-only: deliberately discard its Size/ETag/metadata. */
export async function selectNewestCompleteBackup(s3, bucket) {
  let newest = null
  let continuationToken
  const seenTokens = new Set()

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: BACKUP_PREFIX,
        ContinuationToken: continuationToken,
      })
    )

    for (const object of page.Contents ?? []) {
      if (!completeIdentityFromKey(object.Key)) continue
      const lastModifiedMs = validDateMillis(object.LastModified)
      if (lastModifiedMs === null) {
        throw new Error(`complete backup candidate has invalid LastModified: ${object.Key}`)
      }
      if (
        newest === null ||
        lastModifiedMs > newest.lastModifiedMs ||
        (lastModifiedMs === newest.lastModifiedMs && object.Key.localeCompare(newest.Key) > 0)
      ) {
        newest = { Key: object.Key, lastModifiedMs }
      }
    }

    if (page.IsTruncated) {
      const nextToken = page.NextContinuationToken
      if (typeof nextToken !== 'string' || nextToken === '' || seenTokens.has(nextToken)) {
        throw new Error('R2 LIST pagination returned an invalid continuation token')
      }
      seenTokens.add(nextToken)
      continuationToken = nextToken
    } else {
      continuationToken = undefined
    }
  } while (continuationToken)

  return newest
}

export async function checkBackupFreshness({
  s3,
  bucket = 'arena-backups',
  now = new Date(),
  maxAgeHours = MAX_BACKUP_AGE_HOURS,
}) {
  if (!s3 || typeof s3.send !== 'function') {
    throw new Error('an S3 client is required')
  }
  const nowMs = validDateMillis(now)
  if (nowMs === null) throw new Error('freshness clock is invalid')
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('maximum backup age must be a positive finite number')
  }

  const candidate = await selectNewestCompleteBackup(s3, bucket)
  if (!candidate) {
    throw freshnessViolation(
      `R2 bucket ${bucket} has no shared-contract schemas/full backup`,
      `🚨 *备份缺失*：R2 bucket \`${bucket}\` 中没有 shared-contract schemas/full 完整备份（任意 .sql.gz 或旧无后缀 partial 不计入）。`
    )
  }

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: candidate.Key }))
  let selected
  try {
    selected = assertFreshBackupHead(candidate.Key, head)
  } catch (error) {
    throw freshnessViolation(
      `latest complete backup failed HEAD contract: ${candidate.Key}: ${error.message}`,
      `🚨 *备份完整性 contract 失败*\n最新完整备份候选 \`${candidate.Key}\` 的 HEAD 证据无效：${error.message}\n不得回退到更旧对象报绿；请检查 backup producer / R2 metadata。`
    )
  }

  const ageHours = (nowMs - selected.backupDate.getTime()) / HOURS_TO_MS
  const sizeMB = selected.Size / 1024 / 1024
  if (ageHours < 0) {
    throw freshnessViolation(
      `latest complete backup has a future backup-date: ${selected.backupDate.toISOString()}`,
      `🚨 *备份时间无效*：\`${selected.Key}\` 的 backup-date 在未来（${selected.backupDate.toISOString()}），拒绝报绿。`
    )
  }
  if (ageHours > maxAgeHours) {
    throw freshnessViolation(
      `backup is stale: ${selected.Key} is ${ageHours.toFixed(1)}h old > ${maxAgeHours}h`,
      `🚨 *备份过期*（SLO #4 违约）\n最新契约备份 \`${selected.Key}\`（${sizeMB.toFixed(1)}MB）已 ${ageHours.toFixed(1)}h（阈值 ${maxAgeHours}h）\n查 Mac Mini local-cron-backup；手动补：\`BACKUP_SCHEMAS=arena,public npm run backup:r2\``
    )
  }

  return { ...selected, ageHours, sizeMB }
}

export async function sendTelegramAlert(
  text,
  { env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}
) {
  const botToken = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_ALERT_CHAT_ID || env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) {
    logger.log('[Telegram disabled]', text)
    return false
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Telegram alert webhook cannot run because fetch is unavailable')
  }

  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
  const status = Number(response?.status)
  const succeeded =
    Number.isInteger(status) && status >= 200 && status < 300 && response?.ok !== false
  if (!succeeded) {
    throw new Error(
      `Telegram alert webhook returned non-2xx HTTP ${Number.isInteger(status) ? status : 'unknown'}`
    )
  }
  return true
}

export async function runBackupFreshnessCheck({
  env = process.env,
  s3,
  now = new Date(),
  logger = console,
} = {}) {
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY
  const bucket = env.R2_BUCKET || 'arena-backups'

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw sentinelFailure(
      'Missing R2 credentials — sentinel CANNOT run',
      '⚠️ *备份新鲜度哨兵无法运行*：R2 凭证缺失（哨兵盲了 ≠ 备份正常）'
    )
  }

  const client =
    s3 ??
    new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    })
  const result = await checkBackupFreshness({ s3: client, bucket, now })
  logger.log(
    `✅ 应用/全库捕获产物新鲜且契约合格：${result.Key}（${result.sizeMB.toFixed(1)}MB，${result.ageHours.toFixed(1)}h 前）≤ ${MAX_BACKUP_AGE_HOURS}h、HEAD contract 已验证；这不代表 managed auth 恢复已验收`
  )
  return result
}

export async function runBackupFreshnessCli({
  env = process.env,
  s3,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  try {
    await runBackupFreshnessCheck({ env, s3, now, logger })
    return 0
  } catch (checkError) {
    logger.error('[backup-freshness] check failed:', checkError.message)
    const alertText =
      checkError.alertText ??
      `⚠️ *备份新鲜度哨兵执行失败*：${checkError.message}（哨兵挂了 ≠ 备份正常，需人工看一眼）`
    try {
      await sendTelegramAlert(alertText, { env, fetchImpl, logger })
    } catch (alertError) {
      logger.error('[backup-freshness] alert delivery failed:', alertError.message)
      return 2
    }
    return checkError.exitCode === 1 ? 1 : 2
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  runBackupFreshnessCli().then((exitCode) => {
    process.exitCode = exitCode
  })
}
