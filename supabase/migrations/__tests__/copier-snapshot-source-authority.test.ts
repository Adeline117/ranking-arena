import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260804054700_bind_copier_snapshot_source_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/copier-snapshot-source-authority.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const runbook = readFileSync(resolve(root, 'docs/RUNBOOK.md'), 'utf8')

function functionBody(sql: string, signatureNeedle: string): string {
  const start = sql.indexOf(signatureNeedle)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $function$', start)
  expect(bodyStart).toBeGreaterThan(start)
  const end = sql.indexOf('$function$;', bodyStart + 13)
  expect(end).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart, end)
}

function runnerArray(name: string): string {
  const start = runner.indexOf(`${name}=(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = runner.indexOf('\n)', start)
  expect(end).toBeGreaterThan(start)
  return runner.slice(start, end)
}

describe('exact copier snapshot source authority', () => {
  const publicationGuard = functionBody(
    migration,
    'CREATE OR REPLACE FUNCTION\n  arena.enforce_copier_snapshot_publication_source_authority()'
  )
  const traderIdentityGuard = functionBody(
    migration,
    'CREATE OR REPLACE FUNCTION\n  arena.enforce_copier_snapshot_trader_identity()'
  )
  const reader = functionBody(
    migration,
    'CREATE OR REPLACE FUNCTION public.arena_copier_aggregate('
  )
  const capabilities = functionBody(
    migration,
    'CREATE OR REPLACE FUNCTION public.arena_source_capabilities()'
  )

  it('is one locked forward-only PG17 authority transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(migration).toContain("current_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain('LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('20260804-bind-copier-snapshot-source-authority')
    expect(migration).toContain(
      'existing copier snapshot receipt is outside the reviewed source authority'
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('pins the exact reviewed source/depth/verifier matrix and quarantines unsupported claims', () => {
    const contracts: Record<string, string> = {
      'lib/ingest/adapters/binance/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.binance.copiers@2',
      'lib/ingest/adapters/bitget/bots-copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.bitget_bots.copiers@2',
      'lib/ingest/adapters/bitunix/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.bitunix.copiers@3',
      'lib/ingest/adapters/btcc/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.btcc.copiers@2',
      'lib/ingest/adapters/coinex/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.coinex.copiers@2',
      'lib/ingest/adapters/gate/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.gate.copiers@2',
      'lib/ingest/adapters/kucoin/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.kucoin.copiers@2',
      'lib/ingest/adapters/mexc/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.mexc.copiers@2',
      'lib/ingest/adapters/okx/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.okx.copiers@2',
      'lib/ingest/adapters/toobit/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.toobit.copiers@2',
      'lib/ingest/adapters/xt/copier-snapshot.ts':
        'arena.ingest.history-terminal-verifier.xt.copiers@2',
    }
    for (const [path, contract] of Object.entries(contracts)) {
      expect(readFileSync(resolve(root, path), 'utf8')).toContain(contract)
      expect(migration).toContain(contract)
    }

    for (const slug of [
      'binance_futures',
      'binance_spot',
      'bitget_bots_futures',
      'bitget_bots_spot',
      'bitunix_futures',
      'btcc_futures',
      'coinex_futures',
      'gate_futures',
      'kucoin_futures',
      'mexc_futures',
      'okx_futures',
      'toobit_futures',
      'xt_futures',
      'lbank_futures',
    ]) {
      expect(migration).toContain(`'${slug}'`)
    }
    for (const slug of ['bitget_futures', 'bitget_spot', 'bitget_cfd', 'xt_spot']) {
      expect(migration).toMatch(new RegExp(`'${slug}'[\\s\\S]{0,120}'full', 'none', false, NULL`))
    }
    expect(migration).toMatch(
      /'lbank_futures'[\s\S]{0,160}'top3_preview', 'top3_preview', false, NULL/
    )
    expect(migration).toContain(') <> 14 OR EXISTS (')
  })

  it('makes the registry catalog, rows, privacy, and replay definition exact', () => {
    expect(migration).toContain('copier_snapshot_source_authority_publication_shape')
    expect(migration).toContain('NOT publication_eligible IS DISTINCT FROM true')
    expect(migration).toContain('NOT publication_eligible IS DISTINCT FROM false')
    expect(migration).toContain('terminal_verifier_contract IS NULL')
    expect(migration).toContain(') IS TRUE')
    expect(migration.match(/attribute\.attacl IS NOT NULL/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).toContain('has_any_column_privilege')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('owner_copier_snapshot_source_authority_read')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(procedure.oid)')
    expect(migration).toContain('pg_catalog.sha256(')
    expect(migration).not.toContain('extensions.digest(')
    expect(migration).toContain('idx_copier_snapshot_publication_latest')
    expect(migration).toContain('index_row.indisvalid')
    expect(migration).toContain('index_row.indisready')
    expect(migration).toContain('index_row.indislive')
    expect(migration).toContain('copier snapshot RAW trigger inventory drifted')
    expect(migration).toContain('copier snapshot RAW trigger inventory postflight failed')
    expect(migration).toContain('raw_objects_require_tier_a_execution')
    expect(migration).toContain('zz_raw_objects_verify_tier_a_execution')
    expect(migration).toContain('protect_metric_trust_raw_object_before_write')
    expect(migration).toContain('protect_leaderboard_acquisition_raw_evidence_before_write')
    expect(migration).toContain('protect_record_surface_publication_raw_before_write')
    expect(migration).toContain('protect_position_history_raw_evidence_before_write')
  })

  it('serializes exact source authority and rejects every non-GC publication update', () => {
    expect(publicationGuard).toContain('pg_catalog.pg_trigger_depth() > 1')
    expect(publicationGuard).toContain("pg_catalog.to_jsonb(NEW) - 'live_raw_object_id'")
    expect(publicationGuard).toContain("IF TG_OP = 'UPDATE' THEN")
    expect(publicationGuard).toContain('publication receipts are immutable under source authority')
    expect(publicationGuard).toContain('authority.publication_eligible')
    expect(publicationGuard).toContain("source_row.status = 'active'")
    expect(publicationGuard).toContain("source_row.serving_mode = 'serving'")
    expect(publicationGuard).toContain('trader_row.id = NEW.trader_id')
    expect(publicationGuard).toContain('trader_row.source_id = NEW.source_id')
    expect(publicationGuard).toContain('FOR SHARE OF source_row, trader_row')
    expect(
      migration.match(/ENABLE ALWAYS TRIGGER copier_snapshot/g)?.length
    ).toBeGreaterThanOrEqual(5)
  })

  it('freezes registered external trader identity under an exact ALWAYS guard', () => {
    expect(traderIdentityGuard).toContain("IF TG_OP = 'INSERT' THEN")
    expect(traderIdentityGuard).toContain('NEW.id IS NOT DISTINCT FROM OLD.id')
    expect(traderIdentityGuard).toContain('NEW.source_id IS NOT DISTINCT FROM OLD.source_id')
    expect(traderIdentityGuard).toContain(
      'NEW.exchange_trader_id IS NOT DISTINCT FROM\n         OLD.exchange_trader_id'
    )
    expect(traderIdentityGuard).toContain('registered copier trader identity is immutable')
    expect(migration).toContain('ENABLE ALWAYS TRIGGER copier_snapshot_trader_identity_authority')
    expect(
      migration.match(/81cf59f7b3f2c8a69659e282d9767d2e4efd918fe15247854ed18c8074b5f5d9/g)
    ).toHaveLength(2)
  })

  it('replaces the browser reader with exact current V2-only receipt authority', () => {
    expect(reader).toContain('arena.copier-snapshot-receipt-reader@4')
    expect(reader).toContain('arena.copier_snapshot_source_authorities')
    expect(reader).toContain('authority.publication_eligible')
    expect(reader).toContain('latest_receipt_candidate')
    expect(reader).toContain(
      "publication.evidence_contract =\n          'arena.copier-snapshot-publication@2'"
    )
    expect(reader).toContain(
      "publication.publisher_contract =\n          'arena.ingest.copier-snapshot-publisher@2'"
    )
    expect(reader).toContain(
      "publication.raw_trust_artifact_role_at_publication =\n          'copier_snapshot'"
    )
    expect(reader).toContain('NOT raw_object.quarantined')
    expect(reader).not.toContain('arena.copier-snapshot-publication@1')
    expect(reader).not.toContain('copier_snapshot_legacy_fallback_enabled')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)'
    )
  })

  it('overlays live capability only when an @4-visible latest receipt exists', () => {
    expect(capabilities).toContain('arena.copier-snapshot-source-authority@1')
    expect(capabilities).toContain("'copierDepth', source_row.copier_table_depth")
    expect(capabilities).toContain("'servingMode', source_row.serving_mode")
    expect(capabilities).toContain("pg_catalog.jsonb_typeof(capability.cap) = 'object'")
    const publicationScan = capabilities.indexOf(
      'JOIN ONLY arena.copier_snapshot_publications AS publication'
    )
    const traderJoin = capabilities.indexOf('JOIN ONLY arena.traders AS trader_row')
    expect(publicationScan).toBeGreaterThanOrEqual(0)
    expect(traderJoin).toBeGreaterThan(publicationScan)
    expect(capabilities).toContain('trader_row.id = publication.trader_id')
    expect(capabilities).toContain('trader_row.source_id = publication.source_id')
    expect(capabilities).toContain('NOT EXISTS (\n                  SELECT 1')
    expect(capabilities).toContain('newer.trader_id = publication.trader_id')
    expect(capabilities).toContain('NOT raw_object.quarantined')
    expect(capabilities).toContain("source_row.status = 'active'")
    expect(capabilities).toContain("source_row.serving_mode = 'serving'")
    expect(capabilities).not.toContain('FROM arena.traders')
  })

  it('proves hostile install, DML, reader, capability, replay, and concurrency paths on PG17', () => {
    for (const marker of [
      'missing canonical copier source was accepted',
      'unreviewed non-none source was accepted',
      'noncanonical reviewed copier trader identity was accepted',
      'old weak verifier receipt was accepted',
      'unregistered LBank receipt was accepted',
      'first-install publication table ACL drift was repaired',
      'missing canonical V2 publisher was accepted',
      'trader identity guard function drift was repaired on replay',
      'trader identity guard ACL drift was accepted on replay',
      'disabled ALWAYS trader identity trigger was repaired on replay',
      'registry column ACL drift was accepted on replay',
      'missing latest-receipt index was accepted on replay',
      'reader catalog definition drift was accepted on replay',
      'malformed materialized capability payload crossed the live overlay',
      'replica-mode exact publication rewrite bypassed immutability',
      'replica-mode registered trader primary-key rewrite was accepted',
      'publication-first race reassigned an immutable receipt',
      'rename-first race reassigned an immutable receipt',
      'publication raced through a concurrent source demotion',
      'nested RAW GC did not preserve the immutable receipt tombstone contract',
      'eligible registry row accepted SQL NULL verifier',
      'non-LBank non-publication registry identity was accepted',
      'LBank non-publication row accepted a verifier contract',
      'latest invalid receipt did not hide capability and reader',
      'quarantined RAW receipt remained capability- or reader-visible',
      'unreviewed RAW evidence trigger was accepted',
      'unreviewed RAW evidence trigger was accepted on replay',
      'copier snapshot source authority 054700 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('keeps 0547 manual and the historical 0550 cutover permanently on HOLD', () => {
    for (const arrayName of [
      'PREDEPLOY_MIGRATIONS',
      'QUARANTINED_PREDEPLOY_MIGRATIONS',
      'POSTDEPLOY_MIGRATIONS',
      'RECOVERY_PREREQUISITE_MIGRATIONS',
      'CONCURRENT_RECOVERY_MIGRATIONS',
      'RECOVERY_MIGRATIONS',
      'SUPERSEDED_MIGRATIONS',
    ]) {
      expect(runnerArray(arrayName)).not.toContain(migrationName)
      expect(runnerArray(arrayName)).not.toContain(
        '20260804055000_copier_snapshot_direct_write_cutover.sql'
      )
    }
    expect(packageJson).toContain('"qa:copier-snapshot-source-authority-pg17"')
    expect(ci).toContain('npm run qa:copier-snapshot-source-authority-pg17')
    expect(ci).toContain('Prove historical held copier snapshot cutover in isolated PG17')
    expect(ci).not.toContain('Prove manually attested copier snapshot cutover')
    expect(runbook).toContain(migrationName)
    expect(runbook).toContain('rollingRelease=null')
    expect(runbook).toContain('无法证明 exact purge 或旧 SSR HTML 已失效时必须直接 NO-GO')
    expect(runbook).toContain(
      '只启动一个获批 source/trader、bounded、exact artifact SHA 的 V2 canary'
    )
    expect(runbook).toContain('HOLD / 不得执行')
  })
})
