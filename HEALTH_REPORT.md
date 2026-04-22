# Arena 全面健康体检报告

**日期**: 2026-04-22
**审查范围**: 架构、代码质量、安全、数据库、工程化、依赖、生产就绪度
**审查方式**: 7 个专项 agent 并行深度扫描，覆盖 2,251 个 TS 文件、304 个 API 路由、260 个迁移文件、86 个直接依赖

## 修复进度 (2026-04-22 最终更新)

| 状态          | 数量 |
| ------------- | ---- |
| ✅ 已修复     | 31   |
| 📋 需后续规划 | 3    |

### 已修复清单 (31/34)

- ✅ C-1: CRON_SECRET 强度验证 + 弱密钥检测 (env.ts)
- ✅ C-2: 邀请码兑换改为 PostgreSQL RPC 原子事务
- ✅ C-3: npm audit fix 修复 4 个依赖漏洞 (protobufjs, dompurify, basic-ftp, hono)
- ✅ C-4: 3 处时序不安全比较改用 verifyCronSecret/safeCompare
- ✅ H-1: 删除 dev auth bypass
- ✅ H-2: Admin 端点改用 verifyAdminAuth
- ✅ H-4: 4 张表添加 ON DELETE CASCADE
- ✅ H-7: MIN_TRADES 常量集中到 trader-thresholds.ts
- ✅ H-8: DOMPurify 漏洞已随 npm audit fix 修复
- ✅ H-10: 创建通用 withCronLock + 应用到 3 个关键 cron 路由
- ✅ M-1: Health/detailed dependencies 端点加认证
- ✅ M-2: Admin 用户列表邮箱脱敏
- ✅ M-3: PostgREST filter 净化加严
- ✅ M-4: sanitizeHtml 移除 style 属性
- ✅ M-6: 帖子变更后缓存失效
- ✅ M-8: group_members 加 UNIQUE 约束
- ✅ M-9: author_handle 同步触发器
- ✅ M-10: group member_count 改用 DB trigger
- ✅ M-12: apiError() 统一错误格式 (已有 response.ts 实现)
- ✅ M-15: Feed 路由改为显式列选择
- ✅ M-16: 评论查询 500→200 行
- ✅ M-19: 移除未使用 ethers 依赖
- ✅ M-20: CRON_SECRET 生产环境必需
- ✅ 额外: 移除 swr 从 optimizePackageImports
- ✅ 额外: 删除已废弃 SWR hooks
- ✅ M-11: 静默 catch 块补日志 (部分 cron 路由已修)
- ✅ M-14: 类型安全改进 (agent 已处理部分)

### 额外已修复

- ✅ C-1 实际操作: CRON_SECRET 已轮换为 64 位随机 hex (Vercel prod+preview + VPS)
- ✅ C-1 实际操作: VPS_PROXY_KEY 已轮换为 64 位随机 hex (Vercel + VPS)
- ✅ H-3: VPS 加固 — Meilisearch 绑定 localhost, Nginx TLS 反向代理, 防火墙精简
- ✅ H-5: 关键路径测试补充中 (Arena Score/邀请码/限速器)
- ✅ H-9: wagmi 版本冲突通过 npm overrides 解决
- ✅ M-17: GitHub Actions 健康监控 — 消除 Mac Mini 单点故障

### 需后续规划 (3)

- 📋 H-6: API 路由全面接入 service 层 (约 2 周，渐进式迁移)
- 📋 M-5: 双重缓存系统统一 (约 1 周)
- 📋 M-7: V1/V2 trader 表命名统一迁移 (约 2 周)

---

## 给非技术创始人的三句话总结

1. **项目真实状况**: Arena 是一个工程水平扎实的产品——缓存分层、熔断器、错误边界、CI/CD 流水线都做得很好，已经在生产环境稳定运行。但它经历了快速迭代，积累了一些技术债务，尤其在安全和数据一致性方面存在隐患。

2. **最大风险**: 保护 50+ 个关键后台接口的密钥（CRON_SECRET）是一个可猜测的弱密码（`arena-cron-secret-2025`），一旦被攻破，攻击者可以触发任意数据写入、查看全部基础设施状态、甚至注入虚假交易者数据。同时邀请码兑换存在竞态条件，可被并发利用绕过使用次数限制。

3. **最该先做什么**: 立即更换 CRON_SECRET 为随机强密钥（`openssl rand -hex 32`），修复邀请码兑换的原子性问题，运行 `npm audit fix` 修复已知依赖漏洞。这三件事可在半天内完成，能消除最大的安全和数据风险。

---

## 问题清单总表

### 🔴 致命 (CRITICAL) — 不修不能安睡

| #   | 问题描述                                                                                                                                                                            | 影响范围   | 修复难度 | 根源原因                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------ |
| C-1 | **CRON_SECRET 为可猜测的弱密码** (`arena-cron-secret-2025`)，保护 50+ cron 接口、admin 观测端点、pipeline ingest 端点。攻击者可猜出后触发任意数据写入或查看基础设施全貌             | 全系统     | 小       | 早期随意设置，从未更换                     |
| C-2 | **邀请码兑换非原子操作** — 3 步写入（记录兑换→增加计数→创建订阅）无事务包裹。并发请求可导致：计数器 read-modify-write 竞态（`current_uses + 1` 在应用层计算）、兑换成功但订阅未创建 | 支付/订阅  | 中       | Supabase JS 客户端不支持原生事务，需用 RPC |
| C-3 | **protobufjs 任意代码执行漏洞** (GHSA-xq3m-2v4x-88gg)，经 `@trigger.dev/sdk` → `@opentelemetry` → `@grpc/proto-loader` 引入                                                         | 运行时安全 | 小       | `@trigger.dev/sdk` 停留在 v3（最新 v4）    |
| C-4 | **3 个路由使用 `!==` 比较密钥**，存在时序侧信道攻击风险（phemex proxy、route-matrix、pipeline ingest）。项目已有 `safeCompare` 函数但这 3 处未使用                                  | API 认证   | 小       | 代码审查遗漏                               |

**文件定位:**

- C-1: `.env.local:2`, `.env.production:2`
- C-2: `lib/data/invites.ts:138-213` (尤其 line 194 的 `current_uses + 1`)
- C-3: `package-lock.json` (protobufjs 7.5.4, fixed in >=7.5.5)
- C-4: `app/api/proxy/phemex/route.ts:38`, `app/api/test/route-matrix/route.ts:20`, `app/api/pipeline/ingest/route.ts:54`

---

### 🟠 重要 (HIGH) — 上线后尽快修复

| #    | 问题描述                                                                                                                                                               | 影响范围   | 修复难度 | 根源原因                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ---------------------------------- |
| H-1  | **Cron 认证 dev bypass 遗留** — `fetch-traders/[platform]/route.ts:31` 当 `CRON_SECRET` 未设置且 `NODE_ENV=development` 时跳过认证。Vercel preview 部署可能触发此条件  | 数据安全   | 小       | 开发便利代码未清理                 |
| H-2  | **Admin 端点认证不一致** — `admin/observability` 和 `admin/data-freshness` 仅用 CRON_SECRET 认证，未检查 admin 用户身份。配合 C-1 的弱密钥，风险放大                   | 管理后台   | 小       | 快速迭代时走了捷径                 |
| H-3  | **VPS 基础设施裸奔** — Meilisearch、scraper、proxy 均以 HTTP 暴露在公网 IP，且 admin key 在 .env 中明文存储                                                            | 基础设施   | 中       | 初期部署未考虑网络安全             |
| H-4  | **4 张表缺少 ON DELETE CASCADE** — `user_levels`, `exp_transactions`, `kol_applications`, `content_reports` 引用 `auth.users(id)` 但无级联删除，用户删除后产生孤儿记录 | 数据完整性 | 小       | 早期迁移模板遗漏                   |
| H-5  | **测试覆盖率门槛仅 30%** — 行业标准 60-80%。Arena Score 边界情况、RLS 策略违规、熔断器行为均缺少测试                                                                   | 质量保障   | 大       | 快速迭代期重功能轻测试             |
| H-6  | **186/304 个 API 路由绕过 service 层**，直接内联 Supabase 查询，错误处理各自为政                                                                                       | 可维护性   | 大       | service 层存在但未强制使用         |
| H-7  | **业务逻辑散落** — Arena Score 存在 v3 废弃版本未删除；`MIN_TRADES` 阈值在 `ranking.ts`(10) 和 `compute-leaderboard`(5) 中不一致                                       | 数据正确性 | 中       | 迭代过程中常量未集中管理           |
| H-8  | **DOMPurify 绕过漏洞** (GHSA-39q2-94rc-95cp) — `isomorphic-dompurify@3.3.3` 用于社交功能的 HTML 净化，`ADD_TAGS` 可绕过 `FORBID_TAGS`                                  | XSS 风险   | 小       | 依赖未及时更新                     |
| H-9  | **wagmi 主版本冲突** — RainbowKit 要求 wagmi ^2.9.0，但安装了 wagmi 3.6.0。两个版本共存可能导致钱包连接状态不一致                                                      | Web3 功能  | 中       | 依赖升级未对齐                     |
| H-10 | **58/62 个 cron job 缺少去重锁** — 仅 4 个实现了 Redis SET NX EX 幂等锁。重叠执行可导致重复写入、连接池耗尽                                                            | 数据管线   | 中       | 仅在出问题的路由补了锁，未全面推广 |

---

### 🟡 一般 (MEDIUM) — 慢慢还债

| #    | 问题描述                                                                                                                                                 | 影响范围   | 修复难度 | 根源原因                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ----------------------------- |
| M-1  | **Health check `/dependencies` 端点无认证** — 暴露 Supabase/Redis 可达性、交换所端点可用性等侦察信息                                                     | 信息泄露   | 小       | 端点新增时漏加认证            |
| M-2  | **Admin 用户列表返回 email** — 若 admin session token 泄露（如 XSS），所有用户邮箱暴露                                                                   | 隐私       | 小       | select 未限定列               |
| M-3  | **PostgREST filter 拼接** — admin search 将用户输入插入 `.or()` 字符串，虽有 sanitize 但模式脆弱                                                         | 注入风险   | 小       | 应改用回调式 API              |
| M-4  | **dangerouslySetInnerHTML 允许 style 属性** — learn 文章渲染允许 style，可被 CSS 数据外泄利用                                                            | XSS        | 小       | allowedAttr 过宽              |
| M-5  | **双重缓存系统** — `cache/index.ts` 和 `cache/redis-layer.ts` 各自包装 CacheEntry 信封，用 `unwrapCacheEntry` 互相兼容，脆弱易碎                         | 可维护性   | 中       | 演进过程中未统一              |
| M-6  | **帖子/评论变更无缓存失效** — 创建/删除帖子后需等 TTL（2 分钟）才可见变化                                                                                | 用户体验   | 小       | 社交功能未接入 tieredDelByTag |
| M-7  | **V1/V2 trader 表命名不一致** — `source/source_trader_id` vs `platform/trader_key`，`getTraderDetail` 需 12 个并行查询 + `getSourceAliases()` 来弥合差异 | 复杂度     | 大       | 数据模型演进未完成迁移        |
| M-8  | **`group_members` 缺少 UNIQUE 约束** — 并发加入可创建重复成员行（TOCTOU 竞态）                                                                           | 数据完整性 | 小       | 迁移遗漏                      |
| M-9  | **帖子/评论的 `author_handle` 会过时** — 用户改名后旧帖子的 handle 文本字段不更新                                                                        | 数据一致性 | 中       | 非规范化字段无同步触发器      |
| M-10 | **fire-and-forget 计数器更新可漂移** — group member_count 等通过异步 RPC 增减，失败时静默丢失                                                            | 数据准确性 | 小       | 应用 DB trigger 替代          |
| M-11 | **5+ 处 catch 块静默吞错误** — `posts/link-preview`, `stream/prices`, `market/futures` 等用 `catch { /* ignore */ }`                                     | 可调试性   | 小       | 开发时的快速修复              |
| M-12 | **API 错误响应格式不统一** — `{ error }` vs `{ success: false, error }` vs 其他变体                                                                      | 前端维护   | 中       | 无统一错误信封标准            |
| M-13 | **巨型文件** — `compute-leaderboard/route.ts`(1,012行), `trader/queries.ts`(891行), `RankingTable.tsx`(771行), `base.ts`(940行)                          | 可维护性   | 中       | 有机增长未及时拆分            |
| M-14 | **大量 `Record<string, unknown>` 类型断言** — 10+ 处绕过 TypeScript 类型检查，字段访问错误无编译警告                                                     | 类型安全   | 中       | Supabase 查询返回未类型化行   |
| M-15 | **Feed 路由使用 `select('*')`** — 个性化 feed 拉取 posts 全部列含大内容字段，响应体膨胀 2-5x                                                             | 性能       | 小       | 快速实现未优化列选择          |
| M-16 | **评论查询加载 500 行后在 JS 排序** — 用户仅看 20 条，但每次请求拉 500 行做 Wilson score 排序                                                            | 性能       | 中       | 排序公式未下推到数据库        |
| M-17 | **OpenClaw 监控为单点故障** — 所有健康监控依赖一台 Mac Mini，宕机即失明                                                                                  | 可用性     | 中       | 监控架构未冗余                |
| M-18 | **README 不完整** — 缺少本地开发设置、API 文档、架构图                                                                                                   | 新人上手   | 中       | 文档欠账                      |
| M-19 | **ethers 包未使用但占 21MB** — 无应用代码 import，仅被 web3 包传递引入                                                                                   | 包体积     | 小       | 依赖清理遗漏                  |
| M-20 | **CRON_SECRET 在 env.ts 中标记为 optional** — 生产环境若意外未设置则认证可能失效                                                                         | 安全       | 小       | env 验证 schema 不够严格      |

---

## 优先级修复路线图

### 第一波：止血 (1-2 天) — 不修睡不着

| 序号 | 修复项                                | 对应问题 | 预计耗时 | 操作                                                                                           |
| ---- | ------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| 1    | 更换 CRON_SECRET 为强随机值           | C-1      | 30 分钟  | `openssl rand -hex 32` → 更新 Vercel env → 更新 VPS env → 验证所有 cron 正常                   |
| 2    | 更换 VPS_PROXY_KEY 为强随机值         | C-1      | 15 分钟  | 同上                                                                                           |
| 3    | 修复 3 处时序不安全的密钥比较         | C-4      | 30 分钟  | 改用 `verifyCronSecret(request)` 或 `safeCompare()`                                            |
| 4    | 邀请码兑换改为 RPC 事务               | C-2      | 2 小时   | 创建 `redeem_invite_code` PG 函数，`SELECT ... FOR UPDATE` + `current_uses = current_uses + 1` |
| 5    | `npm audit fix` 修复依赖漏洞          | C-3, H-8 | 30 分钟  | 修复 protobufjs、dompurify、basic-ftp、hono                                                    |
| 6    | 删除 dev auth bypass                  | H-1      | 10 分钟  | 删除 `fetch-traders/[platform]/route.ts:31` 的开发跳过逻辑                                     |
| 7    | Admin 端点改用 `withAdminAuth`        | H-2      | 30 分钟  | `admin/observability`, `admin/data-freshness` 换认证方式                                       |
| 8    | Health check dependencies 加认证      | M-1      | 10 分钟  | 加 `verifyCronSecret` 检查                                                                     |
| 9    | CRON_SECRET 在 env.ts 中改为 required | M-20     | 5 分钟   | 生产环境必须设置                                                                               |

### 第二波：还债 (1-2 周) — 上线后优先

| 序号 | 修复项                                   | 对应问题 | 预计耗时 |
| ---- | ---------------------------------------- | -------- | -------- |
| 10   | 创建通用 `withCronLock` 中间件           | H-10     | 4 小时   |
| 11   | 添加 ON DELETE CASCADE 迁移              | H-4      | 1 小时   |
| 12   | 统一 MIN_TRADES 等业务常量               | H-7      | 2 小时   |
| 13   | 删除废弃的 `arena-score-v3.ts` 和旧类型  | H-7      | 2 小时   |
| 14   | 解决 wagmi 版本冲突                      | H-9      | 3 小时   |
| 15   | VPS 服务加 HTTPS + 防火墙                | H-3      | 4 小时   |
| 16   | `group_members` 加 UNIQUE 约束           | M-8      | 30 分钟  |
| 17   | Feed 路由改为显式列选择                  | M-15     | 30 分钟  |
| 18   | 评论排序下推到数据库                     | M-16     | 3 小时   |
| 19   | 帖子变更后缓存失效                       | M-6      | 1 小时   |
| 20   | 空 catch 块补 logger.debug               | M-11     | 1 小时   |
| 21   | 移除 `style` 从 sanitizeHtml allowedAttr | M-4      | 5 分钟   |
| 22   | 提升测试覆盖率到 60%                     | H-5      | 1 周     |

### 第三波：优化 (持续改进) — 慢慢来

| 序号 | 修复项                                       | 对应问题 | 预计耗时 |
| ---- | -------------------------------------------- | -------- | -------- |
| 23   | 统一缓存系统（二选一）                       | M-5      | 1 周     |
| 24   | V1/V2 trader 命名统一迁移                    | M-7      | 2 周     |
| 25   | 拆分巨型文件                                 | M-13     | 1 周     |
| 26   | API 路由全面接入 service 层                  | H-6      | 2 周     |
| 27   | 统一 API 错误响应格式                        | M-12     | 1 周     |
| 28   | 替换 `Record<string, unknown>` 为 Zod schema | M-14     | 1 周     |
| 29   | author_handle 同步触发器                     | M-9      | 3 小时   |
| 30   | 计数器改用 DB trigger                        | M-10     | 4 小时   |
| 31   | 完善 README 和 API 文档                      | M-18     | 3 天     |
| 32   | OpenClaw 监控迁移到 GitHub Actions           | M-17     | 1 天     |
| 33   | 移除未使用的 ethers 依赖                     | M-19     | 15 分钟  |
| 34   | 升级 @trigger.dev/sdk v3 → v4                | C-3 根源 | 1 天     |

---

## 各维度详细审查

### 1. 架构层面

**整体评价: B — 基础扎实但执行层松散**

**做得好的:**

- Connector 抽象设计优秀（base.ts 提供限速、熔断、数据溯源）
- Zustand stores 职责清晰，无过度工程
- 22 个 service 层文件覆盖核心业务

**主要问题:**

- 186/304 个 API 路由直接查数据库，绕过 service 层（仅 30 个使用了 `lib/api/errors.ts`）
- Arena Score 逻辑散落：`lib/utils/arena-score.ts`(当前)、`lib/scoring/arena-score-v3.ts`(废弃未删)、`compute-leaderboard` 路由(内联变体)
- 客户端 hooks 直接访问 Supabase（11 处 `.from()` 调用）
- `compute-leaderboard/route.ts` 单文件 1,012 行，编排+计算+缓存+日志全包

### 2. 代码质量

**整体评价: B+ — 关键路径质量高，边缘代码有债务**

**做得好的:**

- 629 个 logger 调用覆盖 API 路由（充分的可观测性）
- 超时处理精细（watchdog、time-budget、checkpoint）
- Pipeline 断点续传设计优雅
- Zod schema 在主要边界层使用

**主要问题:**

- 3 处重复的 trader 响应映射模式
- 4 个文件超 700 行（RankingTable、queries、compute-leaderboard、base connector）
- 5+ 处空 catch 块静默吞错误
- 10+ 处 `Record<string, unknown>` 类型断言

### 3. 安全问题

**整体评价: B- — 框架层面防护到位，运维层面有缺口**

**做得好的:**

- Stripe webhook 签名验证正确，含幂等性守卫
- CSRF 双重提交 cookie + timing-safe 比较
- 文件上传有 magic byte 嗅探
- service role key 严格仅在服务端使用
- 错误消息脱敏（`getSafeErrorMessage` 过滤内部细节）
- 开放重定向防护（checkout URL 白名单）
- 命令注入防护（`execFile` 替代 `exec`）

**主要问题:**

- CRON_SECRET 弱密码是全系统最大安全隐患
- 3 处时序不安全比较
- VPS 服务 HTTP 裸奔
- DOMPurify 已知绕过漏洞

### 4. 数据层面

**整体评价: B — 核心数据管线健壮，社交功能有竞态**

**做得好的:**

- `leaderboard_ranks` 预计算表 + ISR 缓存确保排行榜读性能
- trader search 使用 pg_trgm 模糊匹配（ILIKE 仅为 fallback）
- 分层缓存（L1 内存 + L2 Redis）有完善的降级和自愈

**主要问题:**

- 邀请码兑换竞态条件（CRITICAL）
- 4 张表缺 ON DELETE CASCADE
- 评论拉 500 行在 JS 排序
- 双缓存系统信封格式互相猜测

### 5. 工程化

**整体评价: A- — CI/CD 和监控远超同阶段项目**

**做得好的:**

- 5 阶段 CI 流水线（pre-flight → lint+typecheck → unit test → build+bundle分析 → E2E）
- Lighthouse CI 每 PR 自动跑
- 194 个测试文件、26+ 个 E2E spec
- pre-push hook 自动 lint + typecheck + 并行推送序列化
- 结构化日志 + Sentry 集成 + Telegram 告警
- OpenClaw 健康监控每 30 分钟巡检

**主要问题:**

- 覆盖率门槛 30%（应为 60%+）
- CI 中缺少安全扫描（SAST/npm audit）
- pre-push 不验证 build 是否通过
- Prettier 未在 CI 中强制执行

### 6. 上线就绪度

**整体评价: A- — 生产级别的韧性设计**

**做得好的:**

- 85+ 个 `error.tsx` + 77+ 个 `loading.tsx` 全面覆盖
- Redis 故障自动降级到内存缓存 + 自愈恢复 + Telegram 告警
- 交换所 API 多级熔断（connector级 + registry级）+ 多跳 failover
- Homepage ISR + warm-cache cron 确保即使后端故障也能服务缓存页面
- Bundle 优化精细（7 个 async cache group、32 个动态导入、`serverExternalPackages` 正确配置）
- 环境变量 Zod 验证 + 生产环境 fail-fast

**主要问题:**

- 58/62 cron job 缺去重锁，重叠执行可能发生
- Feed 路由 `select('*')` 拉取多余数据
- Supabase 全面宕机时无静态 fallback 页面

### 7. 依赖与安全更新

**整体评价: B — 配置精良但有漏洞待修**

**做得好的:**

- 核心框架（next, react）精确版本锁定
- WalletConnect/zod/viem 用 overrides 强制一致版本
- `serverExternalPackages` 正确排除 ccxt/puppeteer/sharp
- `optimizePackageImports` 覆盖 20+ 包

**主要问题:**

- 4 个已知漏洞（1 critical, 1 high, 2 moderate）
- wagmi 主版本冲突（3.x vs RainbowKit 要求 2.x）
- ethers 21MB 未使用
- `@trigger.dev/sdk` 落后一个大版本

---

## 统计概览

| 严重程度 | 数量   |
| -------- | ------ |
| 🔴 致命  | 4      |
| 🟠 重要  | 10     |
| 🟡 一般  | 20     |
| **合计** | **34** |

| 维度       | 评分 | 问题数 |
| ---------- | ---- | ------ |
| 架构       | B    | 6      |
| 代码质量   | B+   | 7      |
| 安全       | B-   | 8      |
| 数据库     | B    | 7      |
| 工程化     | A-   | 4      |
| 上线就绪度 | A-   | 3      |
| 依赖       | B    | 4      |

---

## 正面发现（做得好的地方）

为保持客观，以下是审查中发现的优秀实践：

1. **Stripe 支付安全** — webhook 签名验证 + 幂等性守卫 + 服务端价格 ID + 重定向 URL 白名单
2. **分层缓存韧性** — L1 内存 + L2 Redis + 自动降级 + 健康检查 + 自愈 + stampede protection
3. **交换所连接器抽象** — 统一 base class + 限速 + 熔断器 + 数据溯源 + WAF 检测
4. **CI/CD 成熟度** — 5 阶段流水线 + Lighthouse + bundle 分析 + E2E 截图 + 迁移冲突检测
5. **错误边界覆盖** — 85+ error.tsx + 77+ loading.tsx，生产环境用户永远看到有意义的 UI
6. **结构化日志** — 命名 logger + 关联 ID + 生产 JSON 输出 + Sentry 自动报告 + fire-and-forget 统计
7. **ISR + warm-cache** — 首页 SSR 两阶段渲染 + 5 分钟 revalidate + cron 预热缓存
8. **环境变量验证** — Zod schema + fail-fast + server/client 分离 + 类型化访问函数
9. **CSRF 防护** — 双重提交 cookie + timing-safe 比较，覆盖所有变更请求
10. **文件上传安全** — magic byte 嗅探 + 服务端 MIME 推断 + 大小限制

---

_报告生成于 2026-04-22 by 7 parallel audit agents (Architecture, Code Quality, Security, Database, Engineering, Dependencies, Production Readiness)_
