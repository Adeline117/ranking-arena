// 公开榜单"封存接线"守卫（docs/DATA_RESUME_PLAN_2026-11.md 停止点 B1，
// 协议见 docs/RANK_PUBLICATION_PROTOCOL.md）。
//
// 部署 main 后，所有公开榜单读取方只读 public.public_ranked_leaderboard。
// 该视图（20260816184500 版本）只返回 rank_publication_id 等于当前
// serving head 的行，而 serving head 只能由 public.seal_leaderboard_rank_publication
// 在同一事务里写入。
//
// 接线方式（session/rank-seal-wiring-20261112）：发布编排在
// lib/rankings/publication/publish-season.ts，由 arena-worker 的
// score:compute 任务在进程内调用（受 V1_RANKING_COMMAND_CHAIN_PUBLISHED 控制）；
// compute-leaderboard 路由仍是墓碑，不是发布入口。
//
// 原守卫只看路由：V1_CRON_EXECUTION_PUBLISHED 为 true 时要求路由调用封存。
// 这与正确的接线不符——唯一的发布入口是 worker，路由打开 cron 常量后依然
// 返回 410。所以本守卫改为：
//   1. 编排器必须按 claim → 带 cohort 写入 → cleanup → rerank → seal → 确认在服务
//      的顺序、在同一个事务里执行；
//   2. worker 的算分任务必须调用编排器，且不再回调墓碑路由；
//   3. 写 leaderboard_ranks 的生产代码只能是编排器；旧的直接写入函数不得有生产调用方；
//   4. 路由要么仍是墓碑，要么调用同一个编排器（不得另起一条不封存的写入路径）。

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
const ORCHESTRATOR = 'lib/rankings/publication/publish-season.ts'
const WORKER_ENTRY = 'worker/src/index.ts'

// Legacy direct writers, deleted 2026-11-13. They never set
// rank_publication_id, so any call would bump the season fence and blank the
// sealed public season. They must not come back.
const LEGACY_WRITERS = [
  'upsertLeaderboard',
  'zeroOutExcluded',
  'atomicPlatformCleanup',
  'cleanupStaleRows',
  'rerankAllRows',
  'persistLeaderboardRanks',
]
const LEGACY_WRITER_FILES = [
  'app/api/cron/compute-leaderboard/write-leaderboard.ts',
  'app/api/cron/compute-leaderboard/rerank-cleanup.ts',
]

// Any production write to public.leaderboard_ranks: PostgREST builder chains
// and raw SQL. Reads (.select) stay allowed everywhere.
const DIRECT_RANK_WRITE = [
  /from\(\s*['"`]leaderboard_ranks['"`]\s*\)\s*\.\s*(?:upsert|insert|update|delete)\s*\(/u,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?leaderboard_ranks"?\b/iu,
]

function directRankWriters(files, readFile) {
  return files.filter((path) => DIRECT_RANK_WRITE.some((pattern) => pattern.test(readFile(path))))
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

const allProductionSources = () =>
  ['app', 'lib', 'worker', 'scripts']
    .flatMap((dir) => productionSources(dir))
    .filter((path) => !path.endsWith('database.types.ts'))

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

// 纯函数，便于用合成输入同时验证正反两种情况。
function assertOrchestratorProtocol(source) {
  const writeSql = source.slice(
    source.indexOf('const WRITE_SQL'),
    source.indexOf('function writeSetSha256')
  )
  assert.match(
    writeSql,
    /rank_publication_id = EXCLUDED\.rank_publication_id/,
    `${ORCHESTRATOR}: 写入语句必须让每行带 cohort（rank_publication_id）`
  )
  const body = source.slice(source.indexOf('export async function publishLeaderboardSeason'))
  const steps = [
    ['deps.database.transaction(', '整个发布必须在一个事务里'],
    ['readSourcePublicationBundle(', '先读评分输入与板证据'],
    ["'expected_source_not_fresh'", '任一 expected source 不新鲜必须拒绝发布'],
    ['claimLeaderboardRankGeneration(', '写入前先 claim generation'],
    ['tx.query(WRITE_SQL', 'claim 之后写入带 cohort 的行'],
    ['cleanupLeaderboardRankPublication(', '写入后 cleanup'],
    ['rerankLeaderboardPublication(', 'cleanup 后整季 rerank'],
    ['sealLeaderboardRankPublication(', '最后封存'],
    ['public_ranked_leaderboard_serving_seasons(', '封存后确认该季已在服务'],
  ]
  let cursor = -1
  for (const [needle, reason] of steps) {
    const index = body.indexOf(needle, cursor + 1)
    assert.ok(index > cursor, `${ORCHESTRATOR}: 缺少或顺序错误：${needle}（${reason}）`)
    cursor = index
  }
}

function assertWorkerPublishes(source) {
  const job = source.slice(source.indexOf('case JOB.COMPUTE_LEADERBOARD:'))
  assert.ok(job.length > 0, 'worker 必须处理 score:compute 任务')
  const body = job.slice(0, job.indexOf('case JOB.SYNC_MEILISEARCH:'))
  assert.match(body, /publishLeaderboardSeason\(/, 'score:compute 必须调用发布编排器')
  assert.doesNotMatch(
    body,
    /\/api\/cron\/compute-leaderboard/,
    'score:compute 不得回调 compute-leaderboard 墓碑路由'
  )
}

function assertRouteIsTombstoneOrOrchestrated(route) {
  const tombstone = /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/
  if (tombstone.test(route) && !/from\s*\(|\.upsert\(|\.insert\(/.test(route)) return
  assert.match(
    route,
    /publishLeaderboardSeason\(/,
    'compute-leaderboard 若恢复执行，只能调用同一个发布编排器，否则公开榜单永远为空'
  )
}

test('编排器按协议顺序、在同一事务内完成一次发布', () => {
  assertOrchestratorProtocol(read(ORCHESTRATOR))
})

test('worker 算分任务调用编排器，而不是墓碑路由', () => {
  assertWorkerPublishes(read(WORKER_ENTRY))
})

test('compute-leaderboard 路由仍是墓碑，或只调用编排器', () => {
  assertRouteIsTombstoneOrOrchestrated(read(ROUTE))
})

test('只有编排器写 leaderboard_ranks.rank_publication_id', () => {
  const writers = allProductionSources().filter((path) =>
    /rank_publication_id\s*=\s*EXCLUDED\.rank_publication_id/.test(read(path))
  )
  assert.deepEqual(writers, [ORCHESTRATOR])
})

test('旧的直接写入函数已删除且不得复活（会破坏封存）', () => {
  for (const file of LEGACY_WRITER_FILES) {
    assert.throws(() => statSync(join(root, file)), /ENOENT/, `${file} 不得恢复`)
  }
  const sources = allProductionSources()
  for (const name of LEGACY_WRITERS) {
    const definers = sources.filter((path) =>
      new RegExp(`(?:function|async)\\s+${name}\\s*\\(`).test(read(path))
    )
    assert.deepEqual(definers, [], `${name} 不得重新定义`)
  }
})

test('除发布编排器外，生产代码不得直写 leaderboard_ranks', () => {
  assert.deepEqual(directRankWriters(allProductionSources(), read), [ORCHESTRATOR])
})

test('守卫在接线缺失时会失败', () => {
  const orchestrator = read(ORCHESTRATOR)
  assert.throws(
    () => assertOrchestratorProtocol(orchestrator.replace('sealLeaderboardRankPublication(', 'x(')),
    /sealLeaderboardRankPublication/
  )
  assert.throws(
    () =>
      assertOrchestratorProtocol(
        orchestrator.replace('rank_publication_id = EXCLUDED.rank_publication_id', '')
      ),
    /cohort/
  )
  assert.throws(
    () =>
      assertWorkerPublishes(
        'case JOB.COMPUTE_LEADERBOARD: { await fetch(`${siteUrl}/api/cron/compute-leaderboard`) }\ncase JOB.SYNC_MEILISEARCH:'
      ),
    /发布编排器|墓碑/
  )
  assert.throws(
    () =>
      assertRouteIsTombstoneOrOrchestrated(
        "export async function GET() { await supabase.from('leaderboard_ranks').upsert(rows) }"
      ),
    /只能调用同一个发布编排器/
  )
  assert.doesNotThrow(() => assertRouteIsTombstoneOrOrchestrated(read(ROUTE)))
  const synthetic = {
    'a.ts': "await supabase\n  .from('leaderboard_ranks')\n  .delete().in('id', ids)",
    'b.ts': "await supabase.from('leaderboard_ranks').upsert(rows)",
    'c.ts': 'await client.query(`UPDATE public.leaderboard_ranks SET rank = NULL`)',
    'd.ts': 'await sql`DELETE FROM leaderboard_ranks WHERE season_id = ${s}`',
    'e.ts': "await supabase.from('leaderboard_ranks').select('id').eq('season_id', s)",
    'f.ts': 'SELECT * FROM public.leaderboard_ranks',
  }
  assert.deepEqual(
    directRankWriters(Object.keys(synthetic), (path) => synthetic[path]),
    ['a.ts', 'b.ts', 'c.ts', 'd.ts']
  )
})
