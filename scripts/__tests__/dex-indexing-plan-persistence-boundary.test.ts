import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLAN_PATH = join(process.cwd(), 'docs', 'DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md')

describe('DEX indexing plan persistence boundary', () => {
  const plan = readFileSync(PLAN_PATH, 'utf8')
  const normalizedPlan = plan.replace(/\s+/gu, ' ')
  const candidateContracts = plan.slice(
    plan.indexOf('#### `candidate_selection_index` / `transaction_membership_index`'),
    plan.indexOf('#### `chain_event_observations`')
  )
  const blockContracts = plan.slice(
    plan.indexOf('#### `chain_event_observations`'),
    plan.indexOf('#### 规范事实')
  )
  const backupContracts = plan.slice(
    plan.indexOf('### 11.4 备份恢复硬门'),
    plan.indexOf('## 12. 回滚与故障降级')
  )

  it('keeps new DEX artifacts metadata-only and fail-closed', () => {
    expect(plan).toContain('新增 DEX event/golden/acquisition 路径')
    expect(plan).toContain('`declared_not_replayed`')
    expect(normalizedPlan).toContain('不得进入 population denominator、serving、rank 或')
    expect(plan).toContain('`golden-rpc-transaction-evidence@3`')
    expect(plan).toContain('`persistence_state=not_persisted`')
    expect(plan).toContain('`content_available_for_replay=false`')
    expect(plan).toContain('content SHA 只是内容完整性承诺，不是对象 locator')
    expect(plan).toContain('`protocol-decoder-golden-binding` 同步升为 @3 并拒绝旧 @2')
    expect(plan).toContain('metadata-only `acquisition-run-manifest@3`')
    expect(plan).toContain(
      '[x] 固定 metadata-only `acquisition-run-manifest@3` / `acquisition-query-policy@2`'
    )
  })

  it('records the resolved v2 raw-archive conflict without opening runtime authorization', () => {
    expect(plan).toContain('`arena.dex.acquisition-run-manifest@2`')
    expect(plan).toContain('`transport.raw_page_archive_required=true`')
    expect(plan).toContain('`claims.artifact_persistence_authorized=false`')
    expect(plan).toContain('后者优先')
    expect(plan).toContain('前一版契约冲突（结构已解除，授权仍关闭）')
    expect(plan).toContain('parser 拒绝 @2/@1')
    expect(plan).toContain('collector 不能运行，也不能写 artifact')
    expect(plan).not.toContain('**现行契约 blocker**')
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
    expect(plan).toContain('仓库内未见 bucket lifecycle-as-code')
    expect(plan).toContain('外部 bucket lifecycle 也尚未验收')
    expect(plan).toContain('可能无限保留')
  })

  it('binds acquisition pages, events, and canonical blocks without body storage', () => {
    expect(plan).toContain('`acquisition_batch_observations` / `acquisition_page_observations`')
    expect(plan).toContain('public_start_height')
    expect(plan).toContain('input_cursor_commitment')
    expect(plan).toContain('previous_page_observation_sha256')
    expect(plan).toContain('batch_id/page_observation_id/page_item_ordinal')
    expect(plan).toContain(
      'chain_block_observations(block_observation_id, chain_id, height, block_hash'
    )
    expect(plan).toContain(
      'source_independence_group, batch_id, page_observation_id, page_item_ordinal'
    )
    expect(plan).toMatch(/fact 行通过\s+`source_event_uid` 传递绑定/u)
    expect(plan).toContain('source_independence_group')
  })

  it('freezes exact request and response content hash bases', () => {
    expect(plan).toContain('request_body_byte_length')
    expect(plan).toContain('content_byte_length')
    expect(plan).toContain('`utf8_json_rpc_request_body_bytes`')
    expect(plan).toContain('`strict_canonical_request_descriptor_utf8_bytes`')
    expect(plan).toContain('`fetch_content_decoded_http_entity_body_bytes_before_utf8`')
    expect(plan).toContain('`reported_content_length` 只是可空的')
    expect(plan).toContain('`arena.strict-canonical-json@1`')
    expect(plan).toMatch(
      /`request_params_sha256 = SHA256\("arena\.dex\.request-params@1\\0" \|\| canonical\(public_params\)\)`/u
    )
    expect(plan).toContain('arena.dex.acquisition-page@1\\0')
    expect(plan).toContain('`arena.dex.acquisition-page-envelope@1`')
    expect(plan).toContain('`arena.dex.acquisition-page-item@1`')
    expect(plan).toContain('`arena.dex.acquisition-page-item-set@1`')
    expect(plan).toContain('`page_item_set_sha256`')
    expect(plan).toContain('`arena.dex.acquisition-batch-chain@1` domain')
    expect(plan).toContain('terminal_page_observation_id')
    expect(plan).toContain('item→page→batch 逐级重算')
    expect(plan).toMatch(
      /batch 语义 header\s+（明确包含 `source_independence_group`、`verification_state`）/u
    )
  })

  it('defines a decoder-independent candidate and complete membership denominator', () => {
    expect(candidateContracts).toContain('`arena.dex.candidate-selection-index@1`')
    expect(candidateContracts).toContain('candidate_selector_contract')
    expect(candidateContracts).toContain('selection_stage=pre_decoder')
    expect(candidateContracts).toContain('execution_filter=none')
    expect(candidateContracts).toContain('`arena.dex.transaction-membership-index@1`')
    expect(candidateContracts).toContain('candidate_selection_index_sha256')
    expect(candidateContracts).toContain('transaction_membership_index_sha256')
    expect(candidateContracts).toContain('verified_in_window_succeeded')
    expect(candidateContracts).toContain('evidence_rejected')
    expect(candidateContracts).toContain('candidate item observations')
    expect(candidateContracts).toContain('global unique transactions')
    expect(candidateContracts).toContain('`selection_set_sha256` / `candidate_set_sha256`')
    expect(candidateContracts).toContain('`membership_set_sha256`')
    expect(candidateContracts).toContain('完整 ordered chunk')
    expect(candidateContracts).toContain('禁止只信 header 自报的 root/count/hash')
    expect(candidateContracts).toMatch(
      /`protocol_scope_id` 的唯一 tuple 固定为\s+`\(chain_id,transaction_id,protocol_id,protocol_deployment_epoch_id\)`/u
    )
    expect(candidateContracts).toMatch(
      /`duplicate_candidate_observation_count = candidate_item_observation_count -\s+global_unique_transaction_count`/u
    )
  })

  it('derives every candidate count from an atomic and exhaustive page-item partition', () => {
    expect(plan).toContain('`acquisition_page_item_observations`')
    expect(plan).toContain('`strict_lossless_canonical_json_utf8_bytes@1`')
    expect(plan).toContain('item ordinal 唯一且正好覆盖 `[0,item_count)`')
    expect(plan).toContain('source_block_hash')
    expect(plan).toContain('batch `item_count` 等于全部')
    expect(plan).toContain('拒绝整页和整批')
    expect(candidateContracts).toContain('写且只写一条 `selection_row`')
    expect(candidateContracts).toContain('一一反连接')
    expect(candidateContracts).toContain('每个 candidate selection row')
    expect(candidateContracts).toContain('必须被一个且仅一个 candidate row 引用')
    expect(candidateContracts).toContain('至少有一个 source observation 和 protocol match')
    expect(candidateContracts).toContain('排序并 exact-dedupe')
  })

  it('keeps unreplayed indexes shadow-only until a recomputed attestation closes the loop', () => {
    expect(candidateContracts).not.toContain('verification_state=declared_not_replayed')
    expect(candidateContracts).toContain('population_denominator_authorized=false')
    expect(candidateContracts).toContain('`arena.dex.denominator-eligibility-attestation@1`')
    expect(candidateContracts).toContain('`eligibility=refetch_recompute_verified`')
    expect(candidateContracts).toMatch(
      /semantic sets 全部相等[\s\S]{0,180}population_denominator_authorized=true/u
    )
    expect(candidateContracts).toContain('`selection_semantic_set_sha256`')
    expect(candidateContracts).toContain('`candidate_semantic_set_sha256`')
    expect(candidateContracts).toContain('`membership_semantic_set_sha256`')
    expect(candidateContracts).toMatch(
      /`declared_not_replayed`[\s\S]{0,160}只能 shadow[\s\S]{0,100}`population_denominator_authorized=false`/u
    )
    expect(candidateContracts).toContain('denominator_eligibility_attestation_sha256')
  })

  it('uses deterministic block-observation supersession and finality bindings', () => {
    expect(blockContracts).toContain('block_observation_id')
    expect(blockContracts).toContain('parent_height')
    expect(blockContracts).toContain('finality_policy_contract')
    expect(blockContracts).toContain('verified_finality_document_sha256')
    expect(blockContracts).toContain('finality_anchor_semantic_sha256')
    expect(blockContracts).toContain('supersedes_observation_id')
    expect(blockContracts).toContain('reverts_observation_id')
    expect(blockContracts).toContain('`observed_at` 不参与胜负')
    expect(blockContracts).toContain('version `n-1`')
    expect(blockContracts).toContain('当前 active commit')
    expect(blockContracts).toContain('不同 block hash 的 `commit(old)→commit(new)` 永远非法')
    expect(blockContracts).toContain('必须先追加显式 revert')
    expect(blockContracts).toContain('finalized produced-slot resolver')
    expect(blockContracts).toContain('相邻 produced block/slot')
    expect(blockContracts).toMatch(/event\s+必须持有确切 `block_observation_id`/u)
  })

  it('keeps protocol manifests draft until epochs and owners are verified', () => {
    expect(plan).toContain('[x] 建 BSC/Solana draft seed protocol manifest')
    expect(plan).toContain('[ ] 验证 BSC factory child set/start/end blocks')
    expect(plan).toContain('`decoder_owner` 从 null 补成可追责 owner')
    expect(plan).not.toContain('[x] 补 BSC/Solana `dex_protocol_manifest`')
  })

  it('requires a checksum-identical empty-cluster restore with explicit objectives', () => {
    expect(backupContracts).toContain('### 11.4 备份恢复硬门')
    expect(backupContracts).toContain('`arena.dex.backup-snapshot@1`')
    expect(backupContracts).toContain('object_inventory_sha256')
    expect(backupContracts).toContain('postgres_active_pointer_snapshot_sha256')
    expect(backupContracts).toContain('latest_included_observed_at')
    expect(backupContracts).toContain('同一 cutoff')
    expect(backupContracts).toContain('隔离的空 ClickHouse 集群')
    expect(backupContracts).toContain('RPO ≤ 15 分钟')
    expect(backupContracts).toContain('RTO ≤ 4 小时')
    expect(backupContracts).toContain('RTO ≤ 24 小时')
    expect(backupContracts).toContain('`dex_source_active_runs`')
    expect(backupContracts).toContain('`arena.dex.postgres-active-pointer-snapshot@1`')
    expect(backupContracts).toContain('candidate_selection_index_sha256')
    expect(backupContracts).toContain('transaction_membership_index_sha256')
    expect(backupContracts).toContain('denominator_eligibility_attestation_sha256')
    expect(backupContracts).toContain('max_logical_time <= cutoff_at')
    expect(backupContracts).toContain('arena.dex.backup-object-inventory@1\\0')
    expect(backupContracts).toContain('snapshot_without_snapshot_id_and_created_at')
    expect(backupContracts).not.toContain('`snapshot_id` 由完整内容')
    expect(backupContracts).toMatch(/必须作为 inventory\s+row 持久化/u)
    expect(backupContracts).toContain('cutoff 必须由协调屏障产生')
    expect(backupContracts).toContain('不得把生产 Postgres 当恢复输入')
  })
})
