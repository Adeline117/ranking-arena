# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：项目在 2026-07-02 前有 7800+ commit 无版本纪律（version 长期停在 0.1.0、
> 无 tag）。本 CHANGELOG 从此建立发布纪律——从 `1.0.0` 起追踪（产品已在
> arenafi.org 生产、有付费用户，1.0.0 是诚实的起点）。历史变更见 git log。

## [Unreleased]

## [1.0.0] - 2026-07-02

首个受追踪版本 = 企业级工程差距整改（详见 `docs/ENTERPRISE_GAP_ANALYSIS_2026-07.md`）。

### Added

- **CI 门禁部署**：push main 不再直通生产；CI 四门禁作业全绿后由 `deploy-gate.yml`
  用 Vercel CLI 部署，内嵌 smoke + 失败自动回滚（ancestry 判定防回退/防饥饿）。
- **API 鉴权覆盖兜底**：`qa:api-auth` 强制每个 route 有 auth 原语或登记公开白名单。
- **可靠性制度**：`docs/SLO.md`（5 条 SLO）、`docs/postmortems/`（模板 + 回填 5 起）、
  备份新鲜度哨兵（`scripts/openclaw/backup-freshness-check.mjs`）。
- **发布纪律**：本 CHANGELOG、`.github/CODEOWNERS`、`docs/RELEASE.md`。
- 迁移漂移只读审计 + 对账产物（`docs/MIGRATION_DRIFT_AUDIT_2026-07-02.md`）。

### Fixed

- **npm audit 16 个 high 清零**（audit fix + viem 嵌套 override 压 ws）——此前
  CI pre-checks 因此常年全红。
- **CI concurrency** 从 per-ref 改 per-SHA：高频直推不再互相取消，门禁作业每 commit 跑完。
- **Vercel 自动回滚端点** v6→v10：旧 `/v6/deployments/{id}/promote` 是 404，
  修正前回滚代码从未可能成功。
- 备份日备静默失败 3 周（SEV2，crontab 调度丢失 + GH 告警 secrets 未配）已止血。
- `trader/onchain-enrich` 公开 POST 无限流（成本放大风险）补 sensitive 限流。

### Changed

- 债务棘轮收紧：`.tsc-legacy-errors.txt` 166 条豁免全量清零（tsc 零错误）；
  货币格式化单一真相源棘轮（禁新增 money/currency 引用）；
  coverage 门槛 14→20 / 12→18 / 10→15。
- 仓库卫生：清理 undefined/、lighthouse 产物；归档 12 个无引用一次性脚本。

[Unreleased]: https://github.com/Adeline117/ranking-arena/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Adeline117/ranking-arena/releases/tag/v1.0.0
