// 公开榜单"封存接线"守卫（docs/DATA_RESUME_PLAN_2026-11.md 停止点 B1）。
//
// 部署 main 后，所有公开榜单读取方只读 public.public_ranked_leaderboard。
// 该视图（20260816184500 版本）只返回 rank_publication_id 等于当前
// serving head 的行，而 serving head 只能由 public.seal_leaderboard_rank_publication
// 在同一事务里写入。截至本守卫加入时，仓库里没有任何生产代码调用封存、
// 也没有任何写入方设置 rank_publication_id——旧的 compute-leaderboard 只做
// 直接 upsert。所以只把 V1 常量改成 true、恢复调度，榜单仍会一直为空。
//
// 本守卫在 V1 停用期间不改变任何行为：常量为 false 时只核对数据库契约
// 没有悄悄变化；常量一旦改为 true，就要求封存链路已经接上，否则 CI 失败。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const read = (path) => readFileSync(join(root, path), 'utf8')

const VIEW_MIGRATION =
  'supabase/migrations/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql'
const SEAL_MIGRATION =
  'supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql'
const ROUTE = 'app/api/cron/compute-leaderboard/route.ts'

function cronExecutionPublished() {
  const gate = read('lib/cron/v1-execution-publication.ts')
  const match = gate.match(/export const V1_CRON_EXECUTION_PUBLISHED\s*=\s*(true|false)\s+as const/)
  assert.ok(match, 'V1_CRON_EXECUTION_PUBLISHED must stay a checked-in boolean literal')
  return match[1] === 'true'
}

function productionSources(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(join(root, path)).isDirectory()) {
      productionSources(path, out)
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(path)
    }
  }
  return out
}

test('公开视图只认封存过的 serving head', () => {
  const sql = read(VIEW_MIGRATION)
  const view = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW public.public_ranked_leaderboard'))
  assert.ok(view.length > 0, 'public_ranked_leaderboard view definition moved')
  assert.match(view, /JOIN ONLY arena\.public_ranked_leaderboard_serving_heads AS head/)
  assert.match(view, /head\.score_cohort_id = rank_row\.rank_publication_id/)

  // serving head 只由封存事务写入 leaderboard_source_freshness 时的触发器生成。
  assert.match(sql, /prosrc LIKE '%arena\.leaderboard_seal_cohort%'/)
  assert.match(
    sql,
    /CREATE TRIGGER leaderboard_source_freshness_capture_serving_authority\s+AFTER INSERT OR UPDATE ON public\.leaderboard_source_freshness/
  )
})

test('封存是整季全有或全无：必须覆盖该季全部 expected source', () => {
  const sql = read(VIEW_MIGRATION)
  assert.match(sql, /v_publication\.source_count IS DISTINCT FROM v_expected_count/)
  assert.match(sql, /serving\.source_as_of <= p_observed_at - interval '48 hours'/)

  const seal = read(SEAL_MIGRATION)
  assert.match(seal, /ranks\.rank_publication_id IS DISTINCT FROM p_score_cohort_id/)
  assert.match(seal, /leaderboard rows were not fully written by the score cohort/)
})

// 纯函数，便于用合成输入同时验证两条分支。
function assertSealWiredBeforeResume({ published, route, rankPublicationWriters }) {
  if (!published) {
    // V1 停用期间路由必须仍是墓碑，不读取任何数据。
    assert.match(
      route,
      /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/
    )
    return
  }
  assert.match(
    route,
    /sealLeaderboardRankPublication/,
    'compute-leaderboard 恢复执行时必须调用 sealLeaderboardRankPublication，否则公开榜单永远为空'
  )
  assert.ok(
    rankPublicationWriters.length > 0,
    '没有任何生产代码写入 leaderboard_ranks.rank_publication_id，封存会以 23514 拒绝'
  )
}

function rankPublicationWriters() {
  return ['app', 'lib', 'worker']
    .flatMap((dir) => productionSources(dir))
    .filter((path) => !path.endsWith('database.types.ts'))
    .filter((path) => /rank_publication_id/.test(read(path)))
}

test('恢复 compute-leaderboard 执行前，必须先接上封存链路（仓库现状）', () => {
  assertSealWiredBeforeResume({
    published: cronExecutionPublished(),
    route: read(ROUTE),
    rankPublicationWriters: rankPublicationWriters(),
  })
})

test('守卫在常量改为 true 而封存未接线时会失败', () => {
  const tombstone = read(ROUTE)
  assert.throws(
    () =>
      assertSealWiredBeforeResume({
        published: true,
        route: tombstone,
        rankPublicationWriters: [],
      }),
    /sealLeaderboardRankPublication/
  )
  assert.throws(
    () =>
      assertSealWiredBeforeResume({
        published: true,
        route: "import { sealLeaderboardRankPublication } from './seal-rank-publication'",
        rankPublicationWriters: [],
      }),
    /rank_publication_id/
  )
  assert.doesNotThrow(() =>
    assertSealWiredBeforeResume({
      published: true,
      route: "import { sealLeaderboardRankPublication } from './seal-rank-publication'",
      rankPublicationWriters: ['app/api/cron/compute-leaderboard/write-leaderboard.ts'],
    })
  )
})
