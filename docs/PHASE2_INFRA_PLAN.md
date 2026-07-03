# Phase 2 基础设施实施计划（要钱/外部资源项）

> 2026-07-02。这些是企业级差距里**需要外部账号/持续付费**、无法纯代码自主完成的项。
> 每项给出:为什么需要、方案、月成本量级、落地步骤。待用户批预算后执行。

## 一、标准可观测性栈（OTel + 时序 metrics + dashboard）

**现状**:Sentry(错误) + 自建 PipelineLogger + Telegram 告警 + 6 个 health 端点。
缺:时序 metrics、SLO dashboard、分级告警路由。

**为什么要钱**:需要一个 metrics 后端(Grafana Cloud / Datadog / Axiom)托管时序数据。

**方案(按性价比)**:

1. **Grafana Cloud 免费层**(推荐起步):10k series / 14 天保留 / 50GB logs。够 Arena
   当前规模。App 侧加 `@vercel/otel` + OTLP exporter 指向 Grafana Cloud。**$0 起步**,
   超量后 ~$50-100/月。
2. Axiom(免费 500GB/月 ingest)——日志向,metrics 弱。
3. Datadog——功能最全但最贵($15-31/host/月),Arena 规模不划算。

**落地步骤**:

1. 注册 Grafana Cloud,拿 OTLP endpoint + API key → Vercel env
2. `npm i @vercel/otel @opentelemetry/api`,`instrumentation.ts` 里 `registerOTel()`
3. 关键路径埋点:API p95、DB 查询时长、ingest 吞吐、Arena Score 计算耗时
4. Grafana 建 dashboard,SLO(docs/SLO.md 那 5 条)配 alert rule → Telegram/PagerDuty
5. 逐步把自建 PipelineLogger 指标迁到 OTel(保留 PipelineLogger 的 DB 审计作用)

**成本**:$0 起步,预计稳定后 $50-100/月。工作量:CC ~1 天,人工 ~1 周。

## 二、基础设施单点故障消除（Mac Mini / VPS → 托管）

**现状(差距 #2)**:Mac Mini 承载 OpenClaw 运维 + 本地 cron + R2 备份编排 +
phemex 独占抓取;SG VPS(2GB RAM/磁盘 95%)跑 scraper/proxy/Meilisearch;JP VPS。
failover 半人工。这是最高的**可用性**风险。

**为什么要钱**:消除单点=把这些迁到冗余托管服务,每项都有月费。

**分项方案**:
| 职责 | 现状 | 目标 | 月成本 |
|------|------|------|--------|
| 定时任务(cron) | Mac Mini crontab | 已部分在 Vercel Cron;本地 cron 迁 GitHub Actions schedule 或 Vercel | $0(GH Actions 免费额度内) |
| DB 备份编排 | Mac Mini → R2 | GitHub Actions 每日 pg_dump→R2(已有 backup:r2 脚本,只需 workflow) | $0 + R2 存储 ~$1/月 |
| Meilisearch | SG VPS | Meilisearch Cloud 或 升级 VPS 内存 | $30/月(Cloud)或 $12/月(升 VPS 到 4GB) |
| scraper/proxy | SG/JP VPS | 保留(地理封锁必须),但升级 SG 内存脱离 95% 磁盘危险 | +$6-12/月 |
| OpenClaw 自治运维 | Mac Mini | 迁到一台小型托管 VM(Fly.io/Railway) | $5-10/月 |

**优先级**:先做 $0 的(cron + 备份迁 GitHub Actions,**备份 workflow 本次已可做**,
见下),再按预算迁 Meilisearch/OpenClaw,scraper 保留。

**落地(免费部分现在就能做)**:

- GitHub Actions 每日备份 workflow(替代 Mac Mini 单点备份编排)
  ⚠️ **安全权衡(需你拍板)**:此 workflow 需把生产 `DATABASE_URL` + R2 凭据放进
  GH Actions secrets——扩大 DB 访问面(GH Actions 环境或恶意 workflow 被攻破 =
  整库可被 exfiltrate)。**当前 SEV2(备份静默失败)已被新鲜度哨兵解决**(>26h 告警),
  所以这个冗余是 defense-in-depth 而非必需。建议:若要做,用**只读/受限角色**的
  连接串(仅 SELECT)而非主 service DATABASE_URL,把泄露影响降到只读。
  我没有自主把主 DATABASE_URL 放进 GH——这是安全决策,留给你定。

**成本**:$0(免费部分)→ 全托管 ~$50-70/月。工作量:CC 分批 ~2 天,人工 ~2 周。

## 三、独立 staging 环境

**现状**:无独立 staging;Vercel preview(PR 自动)充当轻量预览。

**方案**:Vercel 已支持 preview deployments(免费)。真正的 staging 需要:

- 独立 Supabase project(staging DB) — 免费层 or $25/月 Pro
- staging 环境变量组(Vercel 已支持 per-environment env)
- 数据:定期从生产脱敏同步(或用 seed)

**成本**:$0(用 Supabase 免费层 staging)→ $25/月(Pro staging)。工作量:CC ~半天。

## 四、SOC 2 风格控制映射（尽调材料）

**现状**:实际控制已多数具备(RLS、审计日志、加密、备份、事故复盘制度)。
缺:把它们**映射成 SOC 2 控制项清单**的文档。

**方案**:纯文档工作,不要钱。用 Vanta/Drata($数千/年)可自动化,但初期手写清单即可。
本项可纳入下一轮自主文档工作,不阻塞。

**成本**:$0(手写)。工作量:CC ~半天。

---

## 建议执行顺序（按 风险↓ / 成本↑）

1. **$0 且现在能做**:GitHub Actions 备份 workflow(消除 Mac Mini 备份单点)、
   本地 cron 迁 GH Actions、SOC 2 控制清单文档
2. **$0-30/月**:Grafana Cloud 免费层观测栈、Supabase 免费层 staging
3. **$50-70/月**:Meilisearch/OpenClaw 托管、VPS 内存升级
4. 全部落地后单点故障基本消除,月成本 ~$100-150。

> 本文档中标注"$0 现在能做"的项,不需批预算,可直接进下一轮自主工作。
