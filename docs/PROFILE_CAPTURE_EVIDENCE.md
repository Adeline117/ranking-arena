# Tier-B profile 采集证据：来源接入规范

PR #489 规定：`arena.trader_stats` 里的值只有被 attempt-bound 证据认证过，才能进入公开打分。
板（Tier-A）不提供的必需指标（例如 binance_futures 的回撤、blofin 的胜率、bybit_copytrade 的 PnL）
只能来自 Tier-B profile 抓取。本文说明来源如何声明 profile 采集契约，让这些值得到同样严格的认证。

## 组成

| 层         | 位置                                                                       | 作用                                                                        |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 契约       | `lib/ingest/profile-capture/contract.ts`                                   | 每个来源一份 `ProfileCaptureContract`：用哪些端点、哪个字段路径提供哪个指标 |
| 采集判定   | `lib/ingest/profile-capture/capture.ts`                                    | 纯函数 `buildProfileAcquisition`：给出带类型的终态，complete 时附清单       |
| 账本客户端 | `lib/ingest/profile-capture/ledger.ts`                                     | 调 `arena.start/finish_profile_acquisition_attempt`                         |
| 写入       | `lib/ingest/serving/profile-stats-sql.ts`、`publishProfile(opts.evidence)` | 给对应周期的 stats 块盖章                                                   |
| 数据库     | 迁移 `20261116215328`（predeploy）                                         | 契约注册表、只追加账本、`trader_stats` 的 profile 指针和守卫触发器          |
| 发布读取   | 迁移 `20261116215329`（postdeploy）                                        | `publication_score_rows_json@3`：板认证或 profile 认证都可采用              |
| 测试工具   | `lib/ingest/profile-capture/test-helper.ts`                                | 用录制的页面和真实解析器跑一遍 worker 的同一流程                            |

## 契约格式

```ts
import {
  PROFILE_CAPTURE_CONTRACT_DOCUMENT,
  type ProfileCaptureContract,
} from '@/lib/ingest/profile-capture/contract'

export const BINANCE_FUTURES_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: PROFILE_CAPTURE_CONTRACT_DOCUMENT, // 'arena.profile-capture-contract@1'
  captureContract: 'binance_futures-profile-capture@1', // <source_slug>-profile-capture@<n>，任何改动都要升版本
  sourceSlug: 'binance_futures',
  timeframes: [7, 30, 90], // 只有这些周期会开 attempt
  endpoints: [
    {
      id: 'performance', // 小写标识，清单里记录
      origin: 'https://www.example.com', // 必须是裸 https origin
      pathname: '/bapi/.../performance',
      queryAllowlist: ['portfolioId', 'timeRange'], // 只有这些参数进入请求投影哈希
      required: true, // complete 要求每个 required 端点恰好一页
    },
  ],
  metrics: {
    // 指标名用 #489 的词表：roi pnl win_rate mdd sharpe copier_count total_positions sortino calmar volatility
    mdd: { endpoint: 'performance', path: ['data', 'mdd'], transform: 'abs_fraction_to_percent' },
    win_rate: {
      endpoint: 'performance',
      path: ['data', 'winRate'],
      transform: 'fraction_to_percent',
    },
  },
}
```

- `transform`：`identity`、`fraction_to_percent`（×100）、`abs`、`abs_fraction_to_percent`。
  存储值 = transform(RAW 值)，按相对误差 1e-9 比较（只吸收浮点误差，不吸收单位或取整差异）。
- 指标只能来自 required 端点；`path` 里的数字是数组下标；RAW 值可以是数字或数字字符串。
- `assertProfileCaptureContract` 会拒绝：名字和来源不符、周期不在 7/30/90、端点重复、非 https、
  不可认证的指标名、指标指向 optional 端点。

## 采集判定（`buildProfileAcquisition`）

输入：契约、契约哈希、attempt id、交易员 id、周期、这次 attempt 的全部 RAW 页、解析器给出的该周期 stats 块
（`parsed`）、经过 staging 校验后实际存储的块（`stored`）。

| 终态 / 原因                                   | 条件                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `processing_failed / undeclared_endpoint`     | 有一页的 origin+pathname 不在契约里                                                    |
| `processing_failed / duplicate_endpoint_page` | 同一端点出现两页                                                                       |
| `processing_failed / response_not_canonical`  | 响应不是 strict-canonical JSON                                                         |
| `partial / endpoint_missing`                  | 缺 required 端点                                                                       |
| `processing_failed / stats_block_missing`     | 解析器没有给出这个周期的块                                                             |
| `processing_failed / projection_mismatch`     | 解析器给出了值，但声明的字段没有这个值或不相等（契约或解析器有错，整次采集都不算证据） |
| `complete`                                    | 以上都没有发生                                                                         |

worker 还会记录：`upstream_failed / upstream_gone|upstream_error`（抓取失败）、
`processing_failed / raw_persistence_failed|parse_failed`、`quality_rejected / quality_rejected`、
`partial / profile_window_incomplete`。

complete 时一个指标被认证，当且仅当：解析器值非空、等于 RAW 字段值、并且 staging 校验没有改动它
（被截断或置空的值不认证）。解析器给 NULL 的指标是如实缺失，不认证也不算失败。清单
（`profile-acquisition-manifest@1`）包含 attempt id、契约名和哈希、交易员、周期、每页的
`request_projection_sha256` / `response_sha256`、每个被认证指标的端点、路径、RAW 值和存储值；
`sourceRunId` = 清单的 strict-canonical sha256。

注意：Tier-B 按页依次发布，每次 upsert 都会整体替换该周期的类型化值，所以只有该周期**最后一个**块
（`lastStatsBlock`）的值会留在表里，也只有那次发布会盖章。端点分多页的来源，需要解析器在最后一页
给出完整的块，否则前几页的指标不会被认证（测试工具会照实反映这一点）。

## 数据库保证

- `arena.start_profile_acquisition_attempt`：契约必须已注册且哈希一致、周期在注册的周期内、来源 active、
  交易员属于该来源；attempt 序号和开始时间由数据库给出。
- `arena.finish_profile_acquisition_attempt`：每个 attempt 只能有一个终态。引用的 RAW 必须是
  同来源、同交易员、同周期的 `tier_b` RAW，写在 attempt 开始之后，且 `meta.profile_capture` 里的
  `attempt_id` 和 `capture_contract` 与 attempt 一致。complete 的清单必须与 attempt、契约哈希、交易员 id
  一致，请求哈希格式正确，指标都在注册的 `attestable_metrics` 内且值是数字。非 complete 终态不能带清单。
- 账本只能经这两个 RPC 写入；注册表只追加。
- 触发器 `trader_stats_profile_evidence`：
  - 设新 profile 指针的写入，指针必须指向同交易员、同周期的 complete 采集，否则报 22023；
    只认证存储值与清单值完全相等的指标；
  - 其他写入保留指针，但去掉它改动过的已认证值，全部去掉后清空指针；
  - 与 #489 的板指针并存，两者按指标合并，互不作废。
- `publication_score_rows_json@3`：值由板认证，或由 profile 认证且该 attempt 是同来源、同交易员、
  同周期的 complete 采集、开始时间（数据库时钟，抓取之前）晚于 `now - p_max_age_hours`，才会被采用；
  否则为 NULL 并列入 `unevidenced_metrics`。板缺 ROI/PnL/胜率时，profile 认证的值可以补上。
  行的 `as_of` 取板抓取时间、stats 行时间和 profile 开始时间中最早的。

## 如何声明一个来源

1. 在来源的 adapter 目录写契约（例如 `lib/ingest/adapters/<adapter>/profile-capture-contract.ts`），
   对照真实的 `getProfile` URL 和 `parseProfile` 代码写端点和字段路径。
2. 用录制的页面写测试（见下节），证明契约认证的正是你声明的指标。
3. 把契约加进 `contract.ts` 里的 `PROFILE_CAPTURE_CONTRACTS`（键 = source slug）。
4. 用 `scripts/new-migration.sh register_<source>_profile_capture_contract` 生成注册迁移：
   ```sql
   INSERT INTO arena.profile_capture_contracts
     (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
   SELECT id, '<source>-profile-capture@1', '<sha256>', '{7,30,90}', '{mdd,win_rate}'
   FROM arena.sources WHERE slug = '<source>';
   ```
   `<sha256>` 用 `npx tsx -e 'import {profileCaptureContractSha256} from "./lib/ingest/profile-capture/contract"; …'`
   算出，`attestable_metrics` 与契约的 `metrics` 键一致。迁移在 `apply-launch-migrations.sh` 里归类
   （它依赖 20261116215328；在 worker 发布前应用也是惰性的），并加 PG17 证明。
5. 契约有任何改动：升 `@n`，注册一行新的；旧行留着（只追加）。代码和注册哈希不一致时，
   start 会拒绝，worker 记错误日志并照常发布未认证的值（发布侧视为无证据）。

## 测试工具

```ts
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '@/lib/ingest/profile-capture/test-helper'
import { parseProfile } from '../parsers'
import pages from './fixtures/profile-90d.json' // [{ pageIndex, url, payload, fetchedAt }]

it('binance_futures profile contract attests drawdown and win rate', () => {
  expectProfileContractAttests({
    contract: BINANCE_FUTURES_PROFILE_CAPTURE,
    timeframe: 90,
    pages,
    parseProfile,
    ctx: { tfLabelMap: { '90D': 90 } }, // 解析器需要的 ParseCtx 字段
    requiredFields: [], // sources.meta.profile_required_fields
    metrics: ['mdd', 'win_rate'],
  })
})
```

- `runProfileContractFixture` 返回终态、原因、清单、`parsed` 和 `stored`，可以断言反例
  （例如篡改 fixture 的字段后应得到 `projection_mismatch`）。
- `expectProfileContractAttests` 在非 complete 或认证的指标集合不等于 `metrics` 时抛出，消息里带终态和原因。
- 不访问数据库、网络，也不依赖 jest。

## 现状

注册表和代码里的契约表都是空的：上线这些迁移和 worker 后，行为与 #489 完全一样，直到某个来源按上面的步骤声明。
