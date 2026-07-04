# 新源(适配器)Onboarding Checklist

> 数据全面性体系(2026-07,plan「新数据全面性长效体系」)的流程门。
> 目标:新源上线当天,获取有据、显示有门、漂移有哨 —— 不靠作者自觉。

## 背景铁律

- 「该有」的唯一真源 = **代码声明**(`lib/ingest/adapters/expected-metrics.ts`),
  以交易所页面截图为准据(`交易所细节.docx` 模式:逐指标截图核实)。
  `arena.mv_source_capabilities` 是从数据反推的「真有」,**永远不能当契约**
  (循环论证,parser 漏提取会隐形 — 2026-07-03 gate-sharpe 教训)。
- CEX 提供的字段**抓真值或留空,绝不自派生**;自派生仅限纯 DEX
  (hyperliquid/gmx/gtrade,fills/链上回放)。

## Checklist(顺序执行)

1. **截图核实指标清单**:逐指标截交易所页面,确认它真提供什么
   (Sharpe/Sortino 尤其别凭先验说"不提供")。结论进 docx / 记忆。
2. **适配器模块** `lib/ingest/adapters/<name>/`:
   - `parsers.ts` 纯函数(不碰网络/时钟/模块态),RAW 进 Parsed 出
   - `index.ts` 声明 `capabilities`(surface 布尔,逐字段注释引用端点)
   - `register.ts` 加 import(自注册)
3. **fixtures**:真实 RAW 捕获存 `__tests__/fixtures/`,**覆盖每个声明指标**
   (board + 各 TF profile;截断可以,合成不行)。`parsers.test.ts` 跑通。
4. **expectedMetrics 声明**:`expected-metrics.ts` 加条目(编辑规则见文件头:
   加指标必须 parity 证明;删指标必须 UNREACHABLE_FIELDS_LEDGER 结论)。
   多源变体(spot/cfd)指标集不同 → `EXPECTED_METRICS_BY_SOURCE` 按源覆盖。
5. **parity 测试**:`expected-metrics-parity.test.ts` 加该适配器的配方
   (照抄自己 parsers.test.ts 的 bundle 组装),跑绿 —— 声明 ⊆ fixture 实际产出。
6. **registry 检查**:若引入新指标 key,`lib/constants/metric-registry.ts`
   加条目 + 四语言 i18n(`metric-registry.test.ts` 的完整性测试会红给你看)。
7. **sources seed 行**:迁移经 `scripts/new-migration.sh`,INSERT `arena.sources`
   (slug/adapter_slug/timeframes_native/tf_label_map/expected_count/cadence)。
   **别漏 `meta.series_backfill_topn`**(>300 的板才吃回填带;设 100000=全板)。
8. **上线首夜核对四哨兵**:
   - `node scripts/qa/fill-rate-check.mjs`(声明指标有真数据)
   - `node scripts/qa/render-coverage-check.mjs`(DB 有的 API 不丢)
   - worker 日志无 challenge/429/wedge;`npm run qa:schema` 仍绿
   - 次日 06:30 UTC schema-canary Telegram 无新告警

## 相关文件速查

| 什么           | 哪里                                                            |
| -------------- | --------------------------------------------------------------- |
| 指标声明(该有) | `lib/ingest/adapters/expected-metrics.ts`                       |
| parity 测试    | `lib/ingest/adapters/__tests__/expected-metrics-parity.test.ts` |
| 声明→DB 同步   | `worker/src/ingest/scheduler.ts` syncExpectedMetrics(hourly)    |
| 显示登记       | `lib/constants/metric-registry.ts`(+完整性测试)                 |
| 哨兵指标清单   | `scripts/qa/metric-columns.mjs`(单一来源)                       |
| 不可达字段台账 | `docs/UNREACHABLE_FIELDS_LEDGER.md`                             |
| 字段覆盖底账   | `docs/EXCHANGE_FIELD_COVERAGE.md` / `EXCHANGE_FIELD_MAPPING.md` |
