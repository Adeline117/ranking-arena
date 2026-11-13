import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729230000_token_ranking_generation_barrier.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const normalized = migration.replace(/\s+/g, ' ').toLowerCase()
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const generatedTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const runbook = readFileSync(resolve(root, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

describe('token ranking generation barrier', () => {
  it('bootstraps an explicitly unpublished private singleton head', () => {
    expect(normalized).toContain('create table if not exists arena.token_ranking_publication_head')
    expect(normalized).toContain('generation_seq bigint not null default 0')
    expect(normalized).toContain(
      '0::bigint, null::timestamp with time zone, null::date, null::timestamp with time zone'
    )
    expect(normalized).toContain(
      'alter table arena.token_ranking_publication_head enable row level security'
    )
    expect(normalized).toContain(
      'revoke all on table arena.token_ranking_publication_head from public, anon, authenticated, service_role'
    )
    expect(normalized).toContain('published_at must never substitute for it')
  })

  it('publishes both MVs and the generation in one serialized function transaction', () => {
    const refreshStart = normalized.indexOf(
      'create or replace function public.refresh_popular_tokens_mv()'
    )
    const refreshBody = normalized.slice(
      refreshStart,
      normalized.indexOf('$function$;', refreshStart)
    )
    const dailyRefresh = refreshBody.indexOf(
      'refresh materialized view concurrently public.mv_token_trader_daily_90d'
    )
    const popularRefresh = refreshBody.indexOf(
      'refresh materialized view concurrently public.mv_popular_tokens_90d'
    )
    const headUpdate = refreshBody.indexOf(
      'update arena.token_ranking_publication_head as publication'
    )

    expect(refreshStart).toBeGreaterThanOrEqual(0)
    expect(refreshBody).toContain('for update nowait')
    expect(refreshBody).toContain('security definer')
    expect(refreshBody).toContain('set search_path = pg_catalog, pg_temp')
    expect(refreshBody).toContain(`set "timezone" = 'utc'`)
    expect(refreshBody).toContain('published_at = pg_catalog.clock_timestamp()')
    expect(refreshBody).toContain('window_through_date = v_window_through_date')
    expect(refreshBody).toContain('token ranking source contains future utc dates')
    expect(refreshBody).not.toContain("set statement_timeout = '25min'")
    expect(dailyRefresh).toBeGreaterThanOrEqual(0)
    expect(popularRefresh).toBeGreaterThan(dailyRefresh)
    expect(headUpdate).toBeGreaterThan(popularRefresh)
  })

  it('requires a generation on v2 reads and returns complete JSON even for empty pages', () => {
    expect(normalized).toMatch(
      /get_token_trader_rankings_v2\( token_symbol text, lookback_days integer, max_traders integer, row_offset integer, expected_generation bigint \) returns jsonb/
    )
    expect(normalized).toContain("'contract', 'token-ranking-page@1'")
    expect(normalized).toContain("'generation', v_generation::text")
    expect(normalized).toContain("'published_at_epoch_ms', pg_catalog.floor(")
    expect(normalized).toContain("'window_through_date', v_window_through_date")
    expect(normalized).toContain("'traders', coalesce(")
    expect(normalized).toContain("using errcode = '40001', detail = v_generation::text")
    expect(normalized).toContain("using errcode = '55000'")
    expect(normalized).toContain("'contract', 'popular-token-page@1'")
    expect(normalized).toContain('source_as_of = null')
  })

  it('keeps v1 rolling-deploy compatibility and closes runtime ACLs', () => {
    expect(normalized).toContain(
      'create or replace function public.get_token_trader_rankings( token_symbol text'
    )
    expect(normalized).toContain(
      'arena.token_trader_ranking_page_payload_v1( token_symbol, lookback_days, max_traders, row_offset, current_date )'
    )
    expect(normalized).toContain(
      'arena.token_trader_ranking_page_payload_v1( v_token, lookback_days, max_traders, row_offset, v_window_through_date )'
    )
    expect(normalized).toContain('and daily.trade_date <= p_window_through_date')
    expect(normalized).toContain(
      "pg_catalog.current_setting( 'cron.use_background_workers', true ) is distinct from 'off'"
    )
    expect(normalized).toContain(
      "command = 'set statement_timeout = ''25min''; select public.refresh_popular_tokens_mv();'"
    )
    expect(normalized).toContain(
      'revoke all on function public.get_token_trader_rankings_v2( text, integer, integer, integer, bigint ) from public, anon, authenticated, service_role'
    )
    expect(normalized).toContain(
      'grant execute on function public.get_token_trader_rankings_v2( text, integer, integer, integer, bigint ) to service_role'
    )
    expect(normalized).not.toContain(
      'grant execute on function public.refresh_popular_tokens_mv() to service_role'
    )
    expect(normalized).toContain(
      "pg_catalog.has_function_privilege( 'service_role', 'public.refresh_popular_tokens_mv()', 'execute' )"
    )
    expect(normalized).toContain("notify pgrst, 'reload schema'")
  })

  it('runs through its cron-API forward replacement in the ordered predecessor slot', () => {
    // 20261111133259 is this body with only the cron section moved to
    // cron.alter_job; the launch runner supersedes the original with it.
    const replacementName = '20261111133259_token_ranking_generation_barrier_cron_api.sql'
    const arrayEntries = (name: string) => {
      const start = runner.indexOf(`${name}=(\n`)
      const end = runner.indexOf('\n)', start) + 2
      return runner
        .slice(start, end)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d{14}_.+\.sql$/.test(line))
    }
    const orderedTail = arrayEntries('PREDEPLOY_MIGRATIONS')

    expect(orderedTail).not.toContain(migrationName)
    expect(arrayEntries('SUPERSEDED_MIGRATIONS')).toContain(migrationName)
    expect(runner).toContain(`${migrationName}) printf '%s' 20261111133259 ;;`)
    expect(
      orderedTail.slice(
        orderedTail.indexOf(replacementName),
        orderedTail.indexOf(replacementName) + 10
      )
    ).toEqual([
      replacementName,
      '20261111133300_retire_legacy_token_rankings_cron_api.sql',
      '20261111135144_freeze_legacy_position_history_relations_prod_creator.sql',
      '20261111135302_quarantine_bingx_rank_authority_blocked_spot.sql',
      '20260804050000_harden_serving_trader_resolver.sql',
      '20260804051000_harden_serving_source_capabilities.sql',
      '20260804052000_fail_closed_unbound_copier_aggregates.sql',
      '20260804053000_copier_snapshot_publication_substrate.sql',
      '20260804054000_publish_copier_snapshot_atomically.sql',
      '20260808010000_copier_snapshot_trust_raw_role.sql',
    ])
    expect(generatedTypes).toContain('get_token_ranking_publication_head: {')
    expect(generatedTypes).toContain('window_through_date: string | null')
    expect(generatedTypes).toContain('published_at_epoch_ms: number | null')
    expect(generatedTypes).toContain('get_token_trader_rankings_v2: {')
    expect(generatedTypes).toContain('get_popular_tokens_v2: {')
    // V1 NO-GO runbook keeps only the containment inventory and fail-closed
    // requirement; the production head-probe recipe was intentionally removed
    // (docs/RUNBOOK.md "V1 数据库与排名权威门禁").
    expect(runbook).toContain('`20260804042000`、`20260804043000`、`20260804044000`')
    expect(runbook).toContain('20260804044000_freeze_legacy_position_history_relations.sql')
    expect(runbook).toContain('公开 token 面维持 fail closed')
    expect(runbook).toContain('legacy token-ranking surface 仍是 **ACTIVE-EXPOSURE**')
    expect(runbook).not.toContain('/rest/v1/rpc/')
    expect(runbook).not.toContain('.code == "40001"')
    expect(runbook).not.toContain('/rest/v1/rpc/get_popular_tokens_v2')
    expect(runbook).not.toContain('SELECT public.refresh_popular_tokens_mv();')
    expect(runbook).not.toMatch(/generation_seq\s*>=\s*1/)
    expect(packageJson).toContain(
      'supabase/migrations/__tests__/token-trader-rank-authority.pg17.sh'
    )
    expect(packageJson).toContain(
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh'
    )
    expect(ciWorkflow).toContain('run: npm run qa:public-rank-authority-pg17')
  })
})
