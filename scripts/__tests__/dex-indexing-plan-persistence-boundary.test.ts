import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLAN_PATH = join(process.cwd(), 'docs', 'DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md')

describe('DEX indexing plan persistence boundary', () => {
  const plan = readFileSync(PLAN_PATH, 'utf8')

  it('keeps new DEX artifacts metadata-only and fail-closed', () => {
    expect(plan).toContain('新增 DEX event/golden/acquisition 路径')
    expect(plan).toContain('`declared_not_replayed`')
    expect(plan).toContain('不得进入 population denominator、serving、rank 或')
    expect(plan).toContain('metadata-only `acquisition-run-manifest@3`')
  })

  it('records the v2 raw-archive conflict without treating it as authorization', () => {
    expect(plan).toContain('`arena.dex.acquisition-run-manifest@2`')
    expect(plan).toContain('`transport.raw_page_archive_required=true`')
    expect(plan).toContain('`claims.artifact_persistence_authorized=false`')
    expect(plan).toContain('后者优先')
  })

  it('does not prescribe raw provider body storage for the new DEX path', () => {
    for (const forbidden of [
      'ClickHouse raw replay envelope',
      '逐页保存原始响应',
      'raw replay envelope + 规范事实',
      'raw_payload',
      'raw fill',
      '链日志落 RAW',
      'R2 原始归档与恢复流量',
    ]) {
      expect(plan).not.toContain(forbidden)
    }
  })

  it('does not hide the existing gTrade legacy raw persistence path', () => {
    expect(plan).toContain('`tier-c-profile`')
    expect(plan).toContain('`writeRawObject`')
    expect(plan).toContain('`raw-snapshots`')
    expect(plan).toContain('待迁移 blocker')
    expect(plan).toContain('quarantined 对象会跳过')
    expect(plan).toContain('可能无限保留')
  })

  it('binds acquisition pages, events, and canonical blocks without body storage', () => {
    expect(plan).toContain('`acquisition_batch_observations` / `acquisition_page_observations`')
    expect(plan).toContain('public_start_height')
    expect(plan).toContain('input_cursor_commitment')
    expect(plan).toContain('previous_page_observation_sha256')
    expect(plan).toContain('batch_id/page_observation_id/page_item_ordinal')
    expect(plan).toContain('chain_block_observations(chain_id, height, block_hash, parent_hash')
    expect(plan).toContain(
      'source_independence_group, batch_id, page_observation_id, page_item_ordinal'
    )
    expect(plan).toMatch(/fact 行通过\s+`source_event_uid` 传递绑定/u)
    expect(plan).toContain('source_independence_group')
  })

  it('requires a checksum-identical empty-cluster restore with explicit objectives', () => {
    expect(plan).toContain('### 11.4 备份恢复硬门')
    expect(plan).toContain('隔离的空 ClickHouse 集群')
    expect(plan).toContain('RPO ≤ 15 分钟')
    expect(plan).toContain('RTO ≤ 4 小时')
    expect(plan).toContain('RTO ≤ 24 小时')
    expect(plan).toContain('`dex_source_active_runs`')
  })
})
