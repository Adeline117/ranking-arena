#!/usr/bin/env npx tsx
/**
 * Verify Connector Migration — trigger batch-fetch-traders for all groups
 * and check results.
 *
 * Usage:
 *   npx tsx scripts/verify-connector-migration.ts
 *   npx tsx scripts/verify-connector-migration.ts --group=b    # single group
 *   npx tsx scripts/verify-connector-migration.ts --quick      # groups A, B, D1 only
 *
 * Requires: CRON_SECRET, NEXT_PUBLIC_APP_URL (or defaults to localhost:3000)
 */

const _appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const _cronSecret = process.env.CRON_SECRET

const ALL_GROUPS = ['a', 'a2', 'b', 'c', 'd1', 'd2', 'e', 'f', 'h', 'g1', 'g2', 'i']
const QUICK_GROUPS = ['a', 'b', 'd1', 'h']

interface GroupResult {
  group: string
  ok: boolean
  succeeded: number
  failed: number
  totalDurationMs: number
  results: Array<{
    platform: string
    status: string
    totalSaved?: number
    via?: string
    error?: string
  }>
}

async function runGroup(group: string): Promise<GroupResult> {
  const url = `${_appUrl}/api/cron/batch-fetch-traders?group=${group}`
  console.log(`\n⏳ Running group ${group}...`)

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${_cronSecret}` },
      signal: AbortSignal.timeout(600_000), // 10 min timeout
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        group,
        ok: false,
        succeeded: 0,
        failed: 1,
        totalDurationMs: 0,
        results: [{ platform: `group-${group}`, status: 'error', error: `HTTP ${res.status}: ${body.slice(0, 200)}` }],
      }
    }

    const data = await res.json()
    return {
      group,
      ok: data.ok,
      succeeded: data.succeeded,
      failed: data.failed,
      totalDurationMs: data.totalDurationMs,
      results: data.results || [],
    }
  } catch (err) {
    return {
      group,
      ok: false,
      succeeded: 0,
      failed: 1,
      totalDurationMs: 0,
      results: [{ platform: `group-${group}`, status: 'error', error: err instanceof Error ? err.message : String(err) }],
    }
  }
}

async function main() {
  if (!_cronSecret) {
    console.error('❌ _cronSecret env var required')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const singleGroup = args.find(a => a.startsWith('--group='))?.split('=')[1]
  const quick = args.includes('--quick')

  const groups = singleGroup ? [singleGroup] : (quick ? QUICK_GROUPS : ALL_GROUPS)

  console.log(`🔍 Verifying Connector migration for ${groups.length} groups: ${groups.join(', ')}`)
  console.log(`   Target: ${_appUrl}`)
  console.log('')

  const allResults: GroupResult[] = []

  // Run groups sequentially to avoid overwhelming the server
  for (const group of groups) {
    const result = await runGroup(group)
    allResults.push(result)

    // Print per-platform results
    for (const r of result.results) {
      const icon = r.status === 'success' ? '✅' : '❌'
      const via = r.via ? ` (${r.via})` : ''
      const saved = r.totalSaved != null ? ` saved=${r.totalSaved}` : ''
      const err = r.error ? ` error=${r.error.slice(0, 100)}` : ''
      console.log(`  ${icon} ${r.platform}${via}${saved}${err}`)
    }
    console.log(`  ⏱️ Group ${group}: ${result.totalDurationMs}ms, ${result.succeeded} ok, ${result.failed} failed`)
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('📊 MIGRATION VERIFICATION SUMMARY')
  console.log('='.repeat(60))

  let totalOk = 0
  let totalFailed = 0
  const failedPlatforms: string[] = []

  for (const r of allResults) {
    totalOk += r.succeeded
    totalFailed += r.failed
    for (const p of r.results) {
      if (p.status !== 'success') failedPlatforms.push(p.platform)
    }
  }

  console.log(`\nTotal: ${totalOk} succeeded, ${totalFailed} failed`)

  if (failedPlatforms.length > 0) {
    console.log(`\n❌ Failed platforms: ${failedPlatforms.join(', ')}`)
    console.log('   These may need to fall back to Inline Fetcher.')
  } else {
    console.log('\n✅ All platforms passed via Connector framework!')
  }

  // Check which platforms used connector vs inline
  const connectorPlatforms: string[] = []
  const inlinePlatforms: string[] = []
  for (const r of allResults) {
    for (const p of r.results) {
      if (p.via === 'connector') connectorPlatforms.push(p.platform)
      else if (p.via === 'inline') inlinePlatforms.push(p.platform)
    }
  }

  if (connectorPlatforms.length > 0) {
    console.log(`\n🔌 Connector: ${connectorPlatforms.length} platforms`)
  }
  if (inlinePlatforms.length > 0) {
    console.log(`⚠️  Inline fallback: ${inlinePlatforms.length} — ${inlinePlatforms.join(', ')}`)
  }

  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
