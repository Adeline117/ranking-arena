# 脚本专项清理候选清单（2026-02-22）

> 先列清单，再执行低风险分批清理。

## A. 低风险（可立即处理：归档，不硬删）

| 文件路径 | 理由 | 风险等级 | 可恢复性 |
|---|---|---|---|
| `check_bf7d.mjs` | 根目录临时排查脚本，未被 package scripts / 代码引用 | 低 | 可（移入归档） |
| `check_bingx_nulls.mjs` | 同上，临时数据检查用途 | 低 | 可（移入归档） |
| `check_bitfinex.mjs` | 同上，临时检查脚本 | 低 | 可（移入归档） |
| `check_detailed.mjs` | 同上，临时检查脚本 | 低 | 可（移入归档） |
| `check_gaps.mjs` | 同上（且在 `.gitignore` 中可见临时属性） | 低 | 可（移入归档） |
| `check_nulls.mjs` | 同上，临时检查脚本 | 低 | 可（移入归档） |
| `check_progress.mjs` | 同上，临时进度检查 | 低 | 可（移入归档） |
| `check_schema.mjs` | 同上，临时schema检查 | 低 | 可（移入归档） |
| `test_bitfinex_mdd.mjs` | 根目录一次性测试脚本，未被引用 | 低 | 可（移入归档） |
| `scripts/_test-bybit-listing-fields.mjs` | `_test-` 前缀，临时测试脚本，未被引用 | 低 | 可（移入归档） |
| `scripts/_test-bybit-listing.mjs` | 同上 | 低 | 可（移入归档） |
| `scripts/_test-bybit-tc-api.mjs` | 同上 | 低 | 可（移入归档） |
| `scripts/_test-listing2.mjs` | 同上 | 低 | 可（移入归档） |
| `scripts/_test-mexc-api.mjs` | 同上 | 低 | 可（移入归档） |

## B. 待确认（本轮不删不动）

> 规则：数据库相关/用途不明确脚本先标注“待确认”。

| 文件路径 | 待确认原因 | 风险等级 | 建议 |
|---|---|---|---|
| `scripts/import/check_comprehensive.mjs` | 可能用于库表全量巡检/导入校验 | 中 | 先问业务是否仍在用 |
| `scripts/import/check_seasons.mjs` | 可能涉及赛季数据核验 | 中 | 先问后再处理 |
| `scripts/import/check_status.mjs` | 状态核验脚本，可能接入导入流程 | 中 | 先问后再处理 |
| `scripts/import/check_all_platforms.mjs` | 多平台检查，可能是运维脚本 | 中 | 保留 |
| `scripts/import/check_freshness.mjs` | 新鲜度检查可能是定期任务 | 中 | 保留 |
| `scripts/verify/check-db.mjs` | 明确数据库检查脚本 | 中-高 | 保留，人工拍板 |
| `scripts/check_tables.mjs` | 数据表检查脚本 | 中-高 | 保留，人工拍板 |
| `scripts/check_enrichment.mjs` | 富化结果校验脚本，可能仍有价值 | 中 | 保留 |

## 归档策略

- 新建 `scripts/_archive/`，保留原脚本内容与可恢复路径。
- 新建 `scripts/_archive/README.md` 记录归档原则与恢复方式。
- 分批提交（small batches），每批提交后执行 `pnpm tsc --noEmit` 验证。
