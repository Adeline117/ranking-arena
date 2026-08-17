# API 路由文档

按产品域记录当前主要契约；源码中的 `app/api/**/route.ts` 是完整路由清单，公开集成契约以 `docs/openapi.yaml` 为准。owner-only 遗留数据清理面不是公开集成 API，记录在本文但不扩大 OpenAPI 的公开支持面。历史端点数量不作为运行事实。

---

## 目录

1. [交易员数据](#1-交易员数据)
2. [用户管理](#2-用户管理)
3. [帖子与社交](#3-帖子与社交)
4. [群组管理](#4-群组管理)
5. [私信系统](#5-私信系统)
6. [支付与订阅](#6-支付与订阅)
7. [通知与预警](#7-通知与预警)
8. [交易所绑定](#8-交易所绑定)
9. [定时任务](#9-定时任务)
10. [管理后台](#10-管理后台)
11. [工具与其他](#11-工具与其他)

---

## 1. 交易员数据

| 路由                                          | 方法             | 描述                                                                                                                      | 认证 |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---- |
| `/api/traders`                                | GET              | 获取交易员列表                                                                                                            | 可选 |
| `/api/traders/[handle]`                       | GET              | 获取交易员基本信息                                                                                                        | 否   |
| `/api/traders/[handle]/full`                  | GET              | 获取交易员完整信息                                                                                                        | 否   |
| `/api/traders/[handle]/core`                  | GET              | V1 保留 warm serving read；冷 Tier-C bridge 返回 pending，不初始化 provider/ioredis/BullMQ 或读取结果队列                 | 否   |
| `/api/traders/[handle]/records`               | GET              | V1 保留 warm serving read；冷 Tier-C bridge 返回 pending，不初始化 provider/ioredis/BullMQ 或读取结果队列                 | 否   |
| `/api/traders/[handle]/equity`                | GET              | 日序列来源未验证，固定返回 `available:false` 空数组与三层 `no-store`；待带 publication proof 的原子发布恢复               | 否   |
| `/api/traders/[handle]/indicators`            | GET              | 固定封存响应；不从 legacy daily rows 计算指标                                                                             | 否   |
| `/api/traders/[handle]/positions`             | GET              | 获取持仓信息                                                                                                              | 否   |
| `/api/traders/[handle]/percentile`            | GET              | 获取排名百分位                                                                                                            | 否   |
| `/api/traders/claim`                          | GET/POST         | 查询认领状态；提交 Hyperliquid/GMX V2 wallet-signature 认领并进入人工审核                                                 | 是   |
| `/api/traders/claim/wallet-challenge`         | POST             | 签发绑定用户/来源/trader/domain/nonce/expiry 的一次性钱包 challenge；Redis 不可用时 503 fail closed                       | 是   |
| `/api/traders/claim/verify-wallet`            | POST             | 旧预验证入口；匿名先返回 401，已登录返回 410，且不读取 body、消费 nonce 或写数据库                                        | 是   |
| `/api/traders/linked`                         | GET/PATCH/DELETE | 管理已绑定身份；DELETE 使用 service-only 原子解绑 RPC                                                                     | 是   |
| `/api/compare`                                | GET              | 对比交易员                                                                                                                | 可选 |
| `/api/market`                                 | GET              | 获取市场数据                                                                                                              | 否   |
| `/api/market/alpha`                           | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取 query、缓存或请求市场供应商       | 否   |
| `/api/market/arbitrage`                       | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取请求值、缓存或请求交易所行情       | 否   |
| `/api/market/candles`                         | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取 query、选择交易所或获取 K 线      | 否   |
| `/api/market/futures`                         | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取请求值、不读数据库或请求市场供应商 | 否   |
| `/api/market/fear-greed`                      | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取请求值、缓存或请求情绪供应商       | 否   |
| `/api/market/sparklines`                      | GET              | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不读取请求值、内存缓存或请求市场供应商   | 否   |
| `/api/trader/[platform]/[trader_key]`         | GET              | legacy read-compatibility；固定 `refresh_job:null`，不公开旧 queue 状态                                                   | 否   |
| `/api/trader/[platform]/[trader_key]/refresh` | POST             | V1 auth-first `401/410 LEGACY_REFRESH_JOBS_NOT_PUBLISHED` 与三层 `no-store`；不读 body、限流或 queue                      | 是   |
| `/api/trader/[platform]/[trader_key]/history` | GET              | 固定 `forensic_only`/unavailable 空历史；不公开 legacy rows                                                               | 否   |
| `/api/rankings/movers`                        | GET              | 固定 `available:false` 空榜与三层 `no-store`                                                                              | 否   |
| `/api/recommendations/hot`                    | GET              | 固定 `available:false` 空推荐与三层 `no-store`                                                                            | 否   |
| `/api/trader/onchain-enrich`                  | POST             | V1 固定 `410 INGEST_EXECUTION_NOT_PUBLISHED` 与三层 `no-store`；不解析 body、限流、访问 provider 或 serving data          | 否   |

`DELETE /api/traders/linked` 不只是删除一条链接：它在同一事务内把对应 verified claim 转为终态审计记录，移除 `verified_traders`/用户链接的公开 badge 权威，重算主身份与用户资料，并清除 Arena claimed 状态。只有来源、交易员 UID 与 canonical exchange 都能精确对应时，才同时停用 CEX connection 并撤销匹配 authorization；投影漂移会原子失败，无法证明的 legacy credential mapping 不做猜测，必须进入 owner 人工审计门禁。旧 `/api/traders/claim/verify-wallet` 是 auth-first tombstone：匿名请求返回 401，已登录请求返回 410；两种路径都 fail closed，且没有凭据读取、proof consumption、direct-table fallback 或写入。

Legacy `trader_daily_snapshots` 不具备 season/generation/cohort/publication proof。权益、指标、公开历史、V3 history、Movers 与 hot-trader recommendation 因此均 fail closed；不得把空响应解释为“零表现”，也不得恢复旧 producer/backfill/cleanup RPC。

### V1 ingest execution source boundary

固定的 `V1_INGEST_EXECUTION_PUBLISHED=false` 仅覆盖已登记的 native ingest command
path，不是环境开关。其 worker entry 在 dotenv/runtime dependency 初始化前退出；scheduler
和 connection 在数据库、ioredis 或 BullMQ 工作前结束；Tier-C 与 first-party bridge 不接纳新
ingest，受覆盖的 direct ingest scripts 也不启动 ingest。`POST
/api/trader/onchain-enrich` 无条件返回 `410 INGEST_EXECUTION_NOT_PUBLISHED` 和三层
`no-store`，先于 body、限流、provider 或 serving-data 工作。

`/core` 与 `/records` 的 warm serving-read 分支仍可使用；当它们需要 Tier-C 时，bridge 在
provider、ioredis、BullMQ 或 result-queue access 前返回 pending。两条 public route 的一般
rate limit 仍可能使用 Redis，因此这里不声称路由完全不读 Redis。此源码守卫不停止、检查或证明
已运行的 host、持久化 queue 或外部 schedule。固定的
已登记的 legacy-refresh source boundary（含 client-safe 固定 false 的
`V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker）另行封存 legacy `refresh_jobs`：
`batch-discover` 为 auth-first `401/410`，`batch-5min` 由第 9 节精确列出的 direct
service-auth cron ingress boundary 单独封存，public trader refresh 不接纳 job，legacy detail
固定 `refresh_job: null`。

### V1 legacy proxy/import acquisition source boundary

本 PR 只封存下列历史 acquisition entrypoint，不把它描述为“所有 source write 已关闭”：

- `GET /api/proxy/phemex` 保留 Edge runtime/region 元数据，但先校验 service
  authentication。缺失或错误认证固定返回 `401 {"error":"Unauthorized"}`；有效认证固定返回
  `410`、`error: "LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED"` 与 unavailable message。两种路径
  都有 `Cache-Control`、`CDN-Cache-Control`、`Vercel-CDN-Cache-Control` 三层 `no-store`，且在
  URL/query 解析、upstream fetch 或 logging 前结束。
- `cloudflare-worker/src/index.ts` 对任意请求固定返回 `410
LEGACY_PROXY_IMPORT_NOT_PUBLISHED` 与同样三层 `no-store`，不做 upstream fetch。
- `scripts/import/import_all_platforms.mjs`、`scripts/import/refresh.sh`、
  `scripts/import/import-all-blocked.sh`、`scripts/import/run_hl_enrichment.sh`、
  `scripts/vps-deploy/scraper-v16-parallel.js`、`scripts/vps-deploy/arena-proxy.mjs`、
  `scripts/archive/test-vps-scrapers.ts` 与
  `scripts/archive/verify-data-accuracy.mjs` 固定报告 `RETIRED` 并以 `2` 退出，不启动 proxy、
  browser、import 或 host 工作。

这是 source-only containment，不停止、不检查也不证明已部署 Cloudflare Worker、VPS
proxy/scraper、host process、queue 或 schedule。它不涵盖单独封存的 worker
`avatar-mirror` 或下方单独封存的 avatar-proxy route；其他 avatar-related API path/helper、
UI/read RPC、adapter 与未列 writer 仍须独立审查。

### V1 avatar-proxy source boundary

匿名 `GET /api/avatar` 及其 `/api/v1/avatar` rewrite alias 解析到同一固定 `410`
source-only response。两条路径均带 `Cache-Control`、`CDN-Cache-Control`、
`Vercel-CDN-Cache-Control` 三层 `no-store`，并在 query 解析、DNS lookup、upstream fetch 或
logging 前结束；matching proxy bypass 只保证此匿名 no-store response contract，不是 upstream
proxy permission。已登记的 helper 与已知 UI/OG consumer 不再生成 proxy request：需要 proxy 的
origin 没有 mirror 时使用 local、inline 或 default fallback。

这不声称所有 avatar browser/network request 为零：existing Supabase mirror 与 direct allowed
raw-avatar URL 仍可能 render，其他 avatar-related API path/helper、adapter 与未列 writer 仍在
范围外。该 source-only change 不能清除旧 CDN cache、停止 older deployed code，也不能证明
external state。

### V1 avatar-backfill source boundary

canonical `GET /api/cron/backfill-avatars` 路由及其
`/api/v1/cron/backfill-avatars` rewrite alias 解析到同一 source-only tombstone handler：
先校验 service authentication，缺失或无效认证固定返回 `401`；有效认证固定返回 `410
CRON_EXECUTION_NOT_PUBLISHED`。两条路径均带 `Cache-Control`、`CDN-Cache-Control`、
`Vercel-CDN-Cache-Control` 三层 `no-store`，并在参数解析、数据库、logging 或 upstream fetch 前
结束。该源码契约不停止、不检查也不证明已部署 host、external scheduler 或 healthcheck。
此 handler 不涵盖单独的 avatar-proxy route、其他 avatar-related API path/helper、UI/read RPC、
adapter 或未列 writer；单独的 worker `avatar-mirror` source hold 不扩大该 handler 的结论。

### V1 avatar-mirror worker source boundary

checked-in `avatar-mirror` worker execution 已单独 source-only retired：processor 为 no-op，
scheduler 不再生产 avatar-mirror job；legacy queued avatar-mirror job 在 `route()` 内以 no-op 返回，
早于该 handler 调用 `getConnection()`、获取 per-job source lease 或加载 processor。这不声称外围
worker 或 BullMQ 尚未建立或使用 shared Redis，或尚未获取 job lock。该源码边界不停止、不检查也不
证明已运行的 worker、Redis、host process 或 schedule 已停止。
它不扩大单独的 avatar-proxy boundary，也不涵盖其他 avatar-related API path/helper、UI/read RPC、
adapter 或未列 writer。

---

## 2. 用户管理

| 路由                                                   | 方法     | 描述                                                                                                                                                                  | 认证 |
| ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `/api/users/[handle]/full`                             | GET      | 获取用户完整资料                                                                                                                                                      | 否   |
| `/api/users/[handle]/follow?list=followers\|following` | GET      | 获取用户粉丝或关注列表                                                                                                                                                | 否   |
| `/api/users/[handle]/bookmark-folders`                 | GET      | 获取用户收藏夹                                                                                                                                                        | 否   |
| `/api/users/follow`                                    | GET/POST | 查询或修改关注状态                                                                                                                                                    | 是   |
| `/api/follow`                                          | GET/POST | 查询或修改关注状态                                                                                                                                                    | 是   |
| `/api/following`                                       | GET      | 获取当前用户关注列表                                                                                                                                                  | 是   |
| `/api/avatar`                                          | GET      | V1 匿名 fixed `410` source hold；三层 `no-store`，不解析 query/DNS/fetch/logging                                                                                      | 否   |
| `/api/v1/avatar`                                       | GET      | rewrite alias → `/api/avatar`；同一 V1 匿名 fixed `410`/三层 `no-store` source hold                                                                                   | 否   |
| `/api/upload-profile-image`                            | POST     | 上传已认证用户的资料图片                                                                                                                                              | 是   |
| `/api/avoid-list`                                      | GET/POST | 屏蔽列表管理                                                                                                                                                          | 是   |
| `/api/referral`                                        | GET/POST | V1 auth-first hold；无认证 401，认证后固定 410 `REFERRAL_PROGRAM_NOT_PUBLISHED`，三层 `no-store`；不解析 endpoint query/body、不限流、不读取/生成推荐码或读写推荐记录 | 是   |
| `/api/referral/apply`                                  | POST     | V1 auth-first hold；无认证 401，认证后固定 410 `REFERRAL_PROGRAM_NOT_PUBLISHED`，三层 `no-store`；不解析 body、不限流、不写 attribution/reward 或推荐记录             | 是   |

### V1 推荐计划展示边界

固定、非环境的 `V1_REFERRAL_PROGRAM_PUBLISHED=false` 同时封存本源码中的 referral
API 和展示/新链接传播：`GET`/`POST /api/referral` 与 `POST /api/referral/apply` 都先完成
认证；无认证返回 `401`，认证通过固定返回 `410 REFERRAL_PROGRAM_NOT_PUBLISHED`，两条路径均有
`Cache-Control`、`CDN-Cache-Control`、`Vercel-CDN-Cache-Control` 三层 `no-store`。认证之后
它们不解析 endpoint query/body、不做 rate limit，也不读取、生成或写入推荐码、attribution、reward
或其他推荐记录（认证本身的身份校验除外）。

`/referral`、Settings 的 Referral card、付款成功页的推荐交叉推广，以及 rank-share URL/card 的
`ref` 参数均不再提供邀请、链接复制、进度或 Pro 奖励承诺。页面只显示 V1 验证暂停状态；已有推荐
历史不构成自动发奖承诺。这是 source-only boundary，不改变或证明任何已部署代码、历史记录或外部
状态。

---

## 3. 帖子与社交

| 路由                            | 方法                | 描述                                                                                                       | 认证     |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `/api/posts`                    | GET/POST            | 帖子列表/发帖                                                                                              | POST: 是 |
| `/api/posts/[id]`               | GET/PUT/DELETE      | 获取、编辑或删除帖子                                                                                       | 写入: 是 |
| `/api/posts/[id]/edit`          | PUT                 | 编辑帖子                                                                                                   | 是       |
| `/api/posts/[id]/delete`        | DELETE              | 删除帖子                                                                                                   | 是       |
| `/api/posts/[id]/like`          | POST                | 点赞帖子                                                                                                   | 是       |
| `/api/posts/[id]/vote`          | POST                | 投票（赞/踩）                                                                                              | 是       |
| `/api/posts/[id]/poll-vote`     | GET/POST            | 查询或提交帖子投票                                                                                         | POST: 是 |
| `/api/posts/[id]/bookmark`      | GET/POST            | 查询或修改收藏状态                                                                                         | 是       |
| `/api/posts/[id]/repost`        | POST                | 转发帖子                                                                                                   | 是       |
| `/api/posts/[id]/pin`           | POST                | 置顶帖子                                                                                                   | 是       |
| `/api/posts/[id]/comments`      | GET/POST/PUT/DELETE | 评论列表与评论写操作                                                                                       | 写入: 是 |
| `/api/posts/[id]/comments/like` | POST                | 点赞评论                                                                                                   | 是       |
| `/api/posts/bookmarks/status`   | POST                | 批量检查收藏状态                                                                                           | 是       |
| `/api/posts/link-preview`       | GET                 | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不解析 URL 或发起预览请求 | 否       |
| `/api/posts/upload-image`       | POST                | 上传图片                                                                                                   | 是       |
| `/api/posts/upload-video`       | POST                | 上传视频                                                                                                   | 是       |

### 收藏夹

| 路由                                   | 方法             | 描述                   | 认证 |
| -------------------------------------- | ---------------- | ---------------------- | ---- |
| `/api/bookmark-folders`                | GET/POST         | 收藏夹列表/创建        | 是   |
| `/api/bookmark-folders/[id]`           | GET/PATCH/DELETE | 获取、更新或删除收藏夹 | 是   |
| `/api/bookmark-folders/[id]/subscribe` | GET/POST/DELETE  | 查询、订阅或退订收藏夹 | 是   |
| `/api/bookmark-folders/subscribed`     | GET              | 已订阅收藏夹           | 是   |

---

## 4. 群组管理

### 群组操作

| 路由                                    | 方法            | 描述                 | 认证   |
| --------------------------------------- | --------------- | -------------------- | ------ |
| `/api/groups/subscribe`                 | GET/POST/DELETE | 查询、加入或退出群组 | 是     |
| `/api/groups/apply`                     | GET/POST        | 查询或申请创建群组   | 是     |
| `/api/groups/applications`              | GET             | 群组申请列表         | 是     |
| `/api/groups/applications/[id]/approve` | POST            | 批准创建申请         | 管理员 |
| `/api/groups/applications/[id]/reject`  | POST            | 拒绝创建申请         | 管理员 |

### 群组编辑

| 路由                                         | 方法     | 描述               | 认证   |
| -------------------------------------------- | -------- | ------------------ | ------ |
| `/api/groups/[id]/edit-apply`                | GET/POST | 查询或申请编辑群组 | 群主   |
| `/api/groups/edit-applications`              | GET      | 编辑申请列表       | 管理员 |
| `/api/groups/edit-applications/[id]/approve` | POST     | 批准编辑申请       | 管理员 |
| `/api/groups/edit-applications/[id]/reject`  | POST     | 拒绝编辑申请       | 管理员 |

### 成员管理

| 路由                                     | 方法        | 描述           | 认证     |
| ---------------------------------------- | ----------- | -------------- | -------- |
| `/api/groups/[id]/members/[userId]/mute` | POST/DELETE | 禁言或解除禁言 | 群管理员 |
| `/api/groups/[id]/members/[userId]/role` | POST        | 更改成员角色   | 群主     |

### 内容管理

| 路由                                           | 方法 | 描述         | 认证     |
| ---------------------------------------------- | ---- | ------------ | -------- |
| `/api/groups/[id]/posts/[postId]/delete`       | POST | 删除群内帖子 | 群管理员 |
| `/api/groups/[id]/comments/[commentId]/delete` | POST | 删除群内评论 | 群管理员 |

### Pro 群组

| 路由                      | 方法            | 描述                          | 认证     |
| ------------------------- | --------------- | ----------------------------- | -------- |
| `/api/pro-official-group` | GET/POST/DELETE | 查询、加入或退出 Pro 官方群组 | Pro 用户 |

---

## 5. 私信系统

| 路由                  | 方法     | 描述            | 认证 |
| --------------------- | -------- | --------------- | ---- |
| `/api/conversations`  | GET      | 会话列表        | 是   |
| `/api/messages`       | GET/POST | 消息列表/发消息 | 是   |
| `/api/messages/start` | POST     | 开始新会话      | 是   |

---

## 6. 支付与订阅

| 路由                          | 方法 | 描述           | 认证          |
| ----------------------------- | ---- | -------------- | ------------- |
| `/api/stripe/create-checkout` | POST | 创建支付会话   | 是            |
| `/api/stripe/verify-session`  | POST | 验证支付状态   | 是            |
| `/api/stripe/portal`          | POST | 客户管理门户   | 是            |
| `/api/stripe/webhook`         | POST | Stripe Webhook | 否 (签名验证) |
| `/api/subscription`           | GET  | 订阅状态       | 是            |
| `/api/tip/checkout`           | POST | 打赏支付       | 是            |

---

## 7. 通知与预警

| 路由                                 | 方法            | 描述                                                                                                                                                                                                                                                              | 认证                      |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/api/notifications`                 | GET/PUT/DELETE  | 查询、更新或删除通知                                                                                                                                                                                                                                              | 是                        |
| `/api/notifications/mark-read`       | POST            | 标记已读                                                                                                                                                                                                                                                          | 是                        |
| `/api/notifications/send`            | POST            | V1 direct internal-delivery hold；保留 `CRON_SECRET` Bearer 或 `x-internal-key`/`INTERNAL_API_KEY` 鉴权；无效认证 `401`，认证通过固定 `410 INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED`，三层 `no-store`；不读 body、不限流、不初始化 Supabase/logger 或写通知行 | Cron Token / Internal Key |
| `/api/push/subscribe`                | POST/DELETE     | 订阅或退订推送                                                                                                                                                                                                                                                    | 是                        |
| `/api/push/send`                     | POST            | V1 auth-first tombstone；401/410/no-store；不读请求体、不查角色或调用推送提供商                                                                                                                                                                                   | 是                        |
| `/api/alerts`                        | GET             | V1 仅查询本人 legacy 提醒历史；`available:false`、`TRADER_ALERTS_NOT_PUBLISHED`、三层 `no-store`                                                                                                                                                                  | 是                        |
| `/api/trader-alerts`                 | GET/POST/DELETE | V1 GET 仅列出本人 legacy 配置，POST 固定 503，DELETE 仅清理本人配置；全程 `no-store`                                                                                                                                                                              | 是                        |
| `/api/notifications/ranking-changes` | POST            | V1 auth-first tombstone；401/410 `no-store`，不读取排名、不写通知或发送邮件/推送                                                                                                                                                                                  | Cron Token                |

V1 不发布交易员提醒监测、新配置、排名变动提醒或个性化投递。`/api/alerts` 和
`/api/trader-alerts` 只保留 owner-scoped legacy 清理/取证面，不能把已有行解释为
仍在监测；未发布响应分别使用 `TRADER_ALERTS_NOT_PUBLISHED` 或
`TRADER_NOTIFICATION_NOT_PUBLISHED`。这些是源码契约，不构成任何已部署计划、
worker 或第三方投递已停止的运行事实。

固定、非环境的 `V1_INTERNAL_NOTIFICATION_DELIVERY_PUBLISHED=false` 只封存
`POST /api/notifications/send` 这个直接、任意 service-auth HTTP ingress。它先由既有
`verifyServiceAuth` 保留 `CRON_SECRET` Bearer 与 `x-internal-key`/`INTERNAL_API_KEY`
认证语义；认证后固定返回 `410 INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED` 和三层
`no-store`，先于 body、rate limit、Supabase/logger 或通知行写入。这一 source-only
boundary 不停止、检查或证明已部署代码、历史通知记录或外部投递状态；站内直接通知路径（包括
正常用户交互、Stripe webhook 和群组流程）不在此 direct ingress hold 的范围内。

---

## 8. 交易所绑定

| 路由                             | 方法            | 描述                                                               | 认证 |
| -------------------------------- | --------------- | ------------------------------------------------------------------ | ---- |
| `/api/exchange/connect`          | POST            | 已退役；固定返回 410，并声明 successor `/api/trader/authorize`     | 否   |
| `/api/exchange/connections`      | GET             | 获取当前用户的安全连接状态投影                                     | 是   |
| `/api/exchange/disconnect`       | DELETE          | 按 canonical exchange 原子停用 connection 并撤销匹配 authorization | 是   |
| `/api/trader/bind-api-key`       | POST            | 已退役；固定返回 410，并声明 successor `/api/trader/authorize`     | 否   |
| `/api/trader/sync`               | POST            | V1 已退役；固定返回 410，账户连接不能触发公共交易员发布            | 否   |
| `/api/trader/authorize`          | POST/GET/DELETE | 绑定只读 API key、列出安全状态、按 authorization ID 原子撤销       | 是   |
| `/api/exchange/verify-ownership` | POST            | 已退役；匿名先返回 401，已登录返回 410；CEX key 不能证明榜单身份   | 是   |
| `/api/exchange/sync`             | POST            | 用户主动验证私有连接并返回私有账户摘要；不发布榜单数据             | 是   |
| `/api/exchange/oauth/authorize`  | GET             | V1 已退役；固定返回 410                                            | 否   |
| `/api/exchange/oauth/callback`   | POST            | V1 已退役；固定返回 410                                            | 否   |
| `/api/exchange/oauth/refresh`    | POST            | V1 已退役；固定返回 410                                            | 否   |

V1 的公开 API-key 绑定选择器只展示 Binance、Bybit、Bitget，即当前有 exchange-authoritative 只读权限证明的来源。旧 `/api/exchange/connect`、`/api/trader/bind-api-key` 与 `/api/trader/sync` 均无条件固定 410；`POST /api/trader/authorize` 是唯一绑定入口。OAuth authorize/callback/refresh 在 V1 全部无条件固定 410，UI 不展示 OAuth；旧 OAuth 写入没有完整只读证明、认证加密和原子生命周期边界，不能作为安全连接入口。`/api/exchange/verify-ownership` 则是 auth-first tombstone：匿名请求返回 401，已登录请求返回 410；两种路径都不读取凭据、访问交易所或写数据库。`POST /api/trader/authorize` 通过 service-only RPC 同时维护 `user_exchange_connections` 与 `trader_authorizations`；同一 canonical exchange 重绑时，旧 active authorization 会在新绑定提交前被原子撤销。它只保存私有账户连接，不创建 claim/badge、不排队或发布公共 first-party 榜单数据。`POST /api/exchange/sync` 只供已登录 owner 手动验证自己的私有连接并返回私有摘要。`DELETE /api/exchange/disconnect` 与 `DELETE /api/trader/authorize` 使用同一个 service-only 原子撤销边界；任一投影写入失败时整单回滚，不允许留下单边 active credential。为清理既存账户，disconnect 还接受后端已有的 OKX 和旧 connect 确实写过的 MEXC、HTX、WEEX、CoinEx base key；GMX 等钱包源、Gate/KuCoin 和猜测别名在 RPC 前返回 400，不做映射猜测。

### 旧版 Portfolio 凭据退役

| 路由                                      | 方法   | 描述                                                                                         | 认证       |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------- | ---------- |
| `/api/portfolio`                          | GET    | 仅列出 owner 的 `id/exchange/label/created_at` 清理元数据；不返回密文                        | 是         |
| `/api/portfolio?id=[uuid]`                | DELETE | 调用 service-only owner-filtered RPC；删除 parent 并由 FK 级联 positions/snapshots           | 是         |
| `/api/portfolio`                          | POST   | V1 已退役；解析 body 或写入凭据前固定返回 410                                                | 否         |
| `/api/portfolio/sync`                     | POST   | V1 已退役；读取/解密凭据或访问交易所前固定返回 410                                           | 否         |
| `/api/portfolio/positions`                | GET    | V1 已退役；固定返回 410                                                                      | 否         |
| `/api/portfolio/snapshots`                | GET    | V1 已退役；固定返回 410                                                                      | 否         |
| `/api/settings/export`                    | POST   | owner data export；`account.legacy_portfolios` 含白名单 metadata/positions/snapshots，无密文 | 是 + CSRF  |
| `/api/portfolio/[address]`                | GET    | 仍在使用的公开 EVM address portfolio 查询；与 `user_portfolios` 旧 CEX 凭据面无关            | 否         |
| `/api/portfolio/suggestions`              | GET    | 已下线；所有 tier 固定返回 403，不提供组合建议                                               | 不适用     |
| `/api/cron/aggregate-portfolio-snapshots` | GET    | 认证 compatibility no-op；返回 `status=retired`、`snapshots=0`，且不在 Vercel schedule 中    | Cron Token |

所有响应均不得暴露旧 API key 密文。`POST /api/settings/export` 不接受 caller-supplied user id；server 只把已认证 user id 传给 service-only `export_legacy_portfolio_data_v1(uuid)`。输出键为 `account.legacy_portfolios = { portfolios, positions, snapshots }`，manifest 对应三个同名前缀数据集；每组最多 250,000 行。portfolio 只含 `id/exchange/label/created_at`，positions 与 snapshots 只含用户可移植的严格白名单业务字段，numeric 以 text 保真；不含 `user_id` 或任何 API key/passphrase ciphertext，child `portfolio_id` 必须属于同一 owner 的导出 parent set。exact bridge SHA 会早于 Portfolio migration 部署，因此 migration 前已认证 export 必须返回 500 fail closed，不能降级为省略 `legacy_portfolios` 的“成功”导出；migration 后才以 HTTP 200、完整三项 manifest/owner rows、零密文/跨 owner 数据及每组超限返回 413 作为可用证明。Arena owner-delete 只清除 Arena 副本及其 child rows，不会调用交易所撤销 key；用户必须另在对应交易所 revoke/rotate。migration 部署后 production 必须核对 exact ledger、三表 table/column ACL、唯一 service metadata policy、两个 service-only RPC、数据保留、export owner scope/字段白名单/上限、跨 owner delete false、delete cascade 与 rollback。

---

## 9. 定时任务 (Cron)

| 路由                                      | 方法     | 描述                                                                                                                                                                                                | 认证       |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `/api/cron/check-trader-alerts`           | GET/POST | V1 auth-first tombstone；401/410/no-store；不评估、不发推送或邮件                                                                                                                                   | Cron Token |
| `/api/cron/broadcast-trader-events`       | GET      | V1 auth-first tombstone；401/410/no-store；不读取交易员事件、不写通知或发推送                                                                                                                       | Cron Token |
| `/api/cron/weekly-digest`                 | GET      | V1 auth-first tombstone；401/410/no-store；不读取订阅者数据、不发送个性化邮件                                                                                                                       | Cron Token |
| `/api/cron/compute-leaderboard`           | GET      | V1 ranking command auth-first hold；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读参数/锁/数据或发布排名                                                        | Cron Token |
| `/api/cron/precompute-composite`          | GET      | V1 ranking command auth-first hold；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读参数/锁/数据或写缓存                                                          | Cron Token |
| `/api/cron/sync-meilisearch`              | GET      | V1 ranking command auth-first hold；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读参数/锁/数据或调用搜索提供方                                                  | Cron Token |
| `/api/cron/pipeline-evaluate`             | GET      | V1 ranking command auth-first hold；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读参数/pipeline log/数据/状态或发送告警                                         | Cron Token |
| `/api/cron/batch-discover`                | GET      | V1 legacy refresh-job auth-first hold；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不创建 jobs 或调用 RPC                                                         | Cron Token |
| `/api/cron/backfill-avatars`              | GET      | V1 avatar-backfill auth-first tombstone；无效认证 401，认证后固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不解析参数、不访问数据库、logging 或 upstream fetch                          | Cron Token |
| `/api/cron/batch-5min`                    | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/check-data-freshness`          | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/cleanup-data`                  | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/cleanup-stuck-logs`            | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/detect-contracts`              | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/fetch-funding-rates`           | GET/POST | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/fetch-market-data`             | GET/POST | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/fetch-open-interest`           | GET/POST | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/qualify-referrals`             | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/smoke-test`                    | GET      | V1 direct service-auth ingress auth-first hold；无效认证 401，有效 secret 固定 410 `CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query/body/lock/`PipelineLogger`/DB/cache/provider/network | Cron Token |
| `/api/cron/aggregate-daily-snapshots`     | GET/POST | 未调度 auth-first tombstone；401/410/no-store；等待 provenance-bound 原子 publisher                                                                                                                 | Cron Token |
| `/api/cron/cleanup-violations`            | GET/POST | 未调度 auth-first tombstone；401/410/no-store；无自动修复 replacement                                                                                                                               | Cron Token |
| `/api/cron/scan-data-quality`             | GET/POST | 未调度 auth-first tombstone；401/410/no-store；需 exact versioned scanner                                                                                                                           | Cron Token |
| `/api/cron/sync-authorized-traders`       | GET      | V1 兼容认证 no-op；不扫描授权、不创建公共 first-party 作业                                                                                                                                          | Cron Token |
| `/api/cron/aggregate-portfolio-snapshots` | GET      | V1 兼容认证 no-op；不读取旧凭据、不写 snapshots，且未被 Vercel 调度                                                                                                                                 | Cron Token |

### V1 ranking-command source boundary

在本源码版本中，下列同一排名命令链的五个 endpoint 使用固定
`V1_CRON_EXECUTION_PUBLISHED=false` 守卫；它不是环境开关。本小节不概括其他
`/api/cron/*` 路由：

- `GET /api/cron/compute-leaderboard`
- `GET /api/cron/precompute-composite`
- `GET /api/cron/sync-meilisearch`
- `GET /api/cron/pipeline-evaluate`
- `GET` / `POST /api/hooks/post-deploy`

上述入口均先验证服务认证；缺失或无效认证返回 `401`，认证有效时固定返回 `410`
`CRON_EXECUTION_NOT_PUBLISHED`。两条路径均带三层 `no-store`，并在 request body/query
解析、锁、pipeline log、缓存、数据库或 provider 调用之前结束。

固定 `V1_RANKING_COMMAND_CHAIN_PUBLISHED=false` 是另一条 legacy downstream ranking
command worker/scheduler/caller 源码链的边界：本版本 worker entry 会在 dotenv、DB、Redis、
BullMQ 或 HTTP 初始化前退出，scheduler/caller 会在 BullMQ、Redis 或 network 工作前返回。
两项源码守卫都不能停止已运行的 host process 或 checkout 外已持久化的 schedule，也不构成其
当前运行状态的证据。

### V1 direct service-auth cron ingress source boundary

同一个固定、非环境的 `V1_CRON_EXECUTION_PUBLISHED=false` source gate 只将下列十个
direct service-auth cron ingress handler 纳入本节边界；它不因此概括其他 `/api/cron/*` 路由：

- `GET /api/cron/batch-5min`
- `GET /api/cron/check-data-freshness`
- `GET /api/cron/cleanup-data`
- `GET /api/cron/cleanup-stuck-logs`
- `GET /api/cron/detect-contracts`
- `GET` / `POST /api/cron/fetch-funding-rates`
- `GET` / `POST /api/cron/fetch-market-data`
- `GET` / `POST /api/cron/fetch-open-interest`
- `GET /api/cron/qualify-referrals`
- `GET /api/cron/smoke-test`

每个入口均 auth-first：缺失或无效 service authentication 返回 `401`；有效 service secret 固定返回
`410 CRON_EXECUTION_NOT_PUBLISHED`。两条路径均带 `Cache-Control`、`CDN-Cache-Control`、
`Vercel-CDN-Cache-Control` 三层 `no-store`，并在 query/body 解析、lock、`PipelineLogger`、
database、cache、provider 或 network 工作前结束。这只是 source-only handler contract，不能停止、
检查或证明已部署 scheduler、host、queue 或 worker。

---

## 10. 管理后台

| 路由                              | 方法     | 描述                                                                                                                                                                                                                                                                                              | 认证                |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/api/admin/users`                | GET      | 用户列表                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/users/[id]/ban`       | POST     | 封禁用户                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/users/[id]/unban`     | POST     | 解封用户                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/reports`              | GET      | 举报列表                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/reports/[id]/resolve` | POST     | 处理举报                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/alert-config`         | GET/POST | 预警配置                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/stats`                | GET      | 系统统计                                                                                                                                                                                                                                                                                          | 管理员              |
| `/api/admin/data-freshness`       | GET      | registry + serving board + `source_as_of` 权威新鲜度（只读、不发告警）                                                                                                                                                                                                                            | 管理员 / Cron Token |
| `/api/admin/sync-subscription`    | POST     | V1 direct billing-reconciliation hold；保留 service CRON、`x-admin-token`、allowlisted admin JWT 鉴权；无效认证 `401`，认证通过固定 `410 BILLING_RECONCILIATION_NOT_PUBLISHED`，三层 `no-store`；不解析 endpoint query、不限流、不执行 endpoint-specific Stripe/Supabase/logger/DB reconciliation | 管理员 / Cron Token |
| `/api/monitoring/freshness`       | GET      | 已退役旧 contract；认证后返回 410 与 successor link                                                                                                                                                                                                                                               | 管理员 / Cron Token |

固定、非环境的 `V1_BILLING_RECONCILIATION_PUBLISHED=false` 只封存
`POST /api/admin/sync-subscription` 这个直接管理员 command。它先由既有
`verifyAdminAuth` 保留 service CRON bearer、`x-admin-token` 与 production
allowlisted active-admin JWT 的认证语义；认证后固定返回
`410 BILLING_RECONCILIATION_NOT_PUBLISHED` 和三层 `no-store`，先于 endpoint
query、rate limit、endpoint-specific Supabase/Stripe/logger/DB 工作。该源码边界不停止、检查或证明
已经部署的代码、Stripe webhook、checkout、customer portal、计划 reconciliation、历史账单记录或外部支付状态。

---

## 11. 工具与其他

| 路由                          | 方法                | 描述                                                                                                                                                                   | 认证       |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `/api/health`                 | GET                 | 健康检查                                                                                                                                                               | 否         |
| `/api/health/detailed`        | GET                 | 详细健康状态                                                                                                                                                           | 否         |
| `/api/health/heartbeat`       | GET                 | V1 source-only heartbeat-history availability hold；无效 service secret `401`，有效 secret 固定 `410 HEARTBEAT_HISTORY_NOT_PUBLISHED`；三层 `no-store`，不打开历史依赖 | Cron Token |
| `/api/health/heartbeat`       | POST                | V1 source-only 写入 hold；无效 service secret `401`，有效 secret 固定 `410 CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不解析 body 或写入数据库                    | Cron Token |
| `/api/health/evaluate-report` | GET                 | V1 source-only evaluator hold；无效 service secret `401`，有效 secret 固定 `410 CRON_EXECUTION_NOT_PUBLISHED`；三层 `no-store`，不读 query 或执行评估工作              | Cron Token |
| `/api/proxy/phemex`           | GET                 | V1 legacy proxy acquisition auth-first hold；无效认证 `401`，有效认证 `410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`；三层 `no-store`，不解析 URL/query、不 fetch 或 log | Cron Token |
| `/api/hooks/post-deploy`      | GET/POST            | V1 ranking-command source hold；auth-first 401/410 `CRON_EXECUTION_NOT_PUBLISHED` 与三层 `no-store`，不读取部署参数或执行发布后评估                                    | Cron Token |
| `/api/cdn-proxy`              | GET                 | V1 public-egress hold；固定 `410 PUBLIC_EGRESS_NOT_PUBLISHED` 与三层 `no-store`，不解析 URL 或代理文档请求                                                             | 否         |
| `/api/translate`              | POST                | 翻译服务                                                                                                                                                               | 是         |
| `/api/settings/export`        | POST                | 当前用户可移植数据导出（24 小时一次，含无密文 legacy Portfolio 数据）                                                                                                  | 是 + CSRF  |
| `/api/saved-filters`          | GET/POST/PUT/DELETE | 查询与管理筛选条件                                                                                                                                                     | 是         |
| `/api/search/suggestions`     | GET                 | 搜索建议                                                                                                                                                               | 否         |
| `/api/portfolio/suggestions`  | GET                 | 已下线；所有 tier 固定返回 403                                                                                                                                         | 不适用     |

人类可读 API 文档页面是 `/api-docs`；机器契约保存在仓库
`docs/openapi.yaml`，不存在 `/api/docs` App Router endpoint。

### V1 health evaluator source boundary

本源码版本中，只有 `GET /api/health/evaluate-report` 使用固定、非环境的
`V1_CRON_EXECUTION_PUBLISHED=false` gate。它先验证 service secret：缺失或无效时返回
`401`，有效时固定返回 `410 CRON_EXECUTION_NOT_PUBLISHED`；两种响应都有三层 `no-store`，且在
query 解析或任何 evaluator state / alert / rate-limit 工作前结束。`/api/v1/health/evaluate-report`
在 rewrite 前仅作该 exact path 的 proxy handoff，不能扩展到其他 versioned health 路由。

这只是 source-only handler contract，不能停止、检查或证明已部署的 code-quality hook、evaluator、
alert delivery 或外部 scheduler 的状态。

### V1 health heartbeat source boundary

本源码版本中，`GET /api/health/heartbeat` 使用固定、非环境的
`V1_HEARTBEAT_HISTORY_PUBLISHED=false` availability hold。它先验证 service secret：缺失或无效时返回
`401`，有效时固定返回 `410 HEARTBEAT_HISTORY_NOT_PUBLISHED`；两种响应都有三层 `no-store`，且在 URL、
历史数据库依赖或底层错误暴露前结束。`POST /api/health/heartbeat` 独立保留固定、非环境的
`V1_CRON_EXECUTION_PUBLISHED=false` write hold：同样先认证，随后固定返回
`410 CRON_EXECUTION_NOT_PUBLISHED`，并在 body 解析或数据库写入前结束。

canonical 和 `/api/v1/health/heartbeat` rewrite alias 都在 rewrite 前仅作该 exact path 的 proxy
handoff，因此两种方法都交给各自 route-owned 的认证和 hold；相邻 health 路径不在此 handoff 内。
管理员 `GET /api/admin/monitoring/enrichment-completeness` 保留其他 enrichment 只读数据，但不再读取
`platform_heartbeats`：为兼容既有 consumer 它返回 `heartbeats: []`，并明确返回
`heartbeat_history: { availability: false, code: 'HEARTBEAT_HISTORY_NOT_PUBLISHED' }`，而不是把空历史显示为健康。

这些都是 source-only handler contracts：它们不停止、检查或证明已经部署的 worker、host、scheduler、
历史 heartbeat 数据、数据库状态或外部监控的状态。

### V1 public-egress source boundary

`GET /api/cdn-proxy`、`GET /api/market/alpha`、`GET /api/market/arbitrage`、
`GET /api/market/candles`、`GET /api/market/futures`、`GET /api/market/fear-greed`、
`GET /api/market/sparklines` 与 `GET /api/posts/link-preview` 共用固定、非环境的
`V1_PUBLIC_EGRESS_PUBLISHED=false` source hold，均固定返回
`410 PUBLIC_EGRESS_NOT_PUBLISHED` 和 `Cache-Control`、`CDN-Cache-Control`、
`Vercel-CDN-Cache-Control` 三层 `no-store`。它们不读取 query、执行 rate limit、CORS、
social feature guard、缓存、DNS lookup、logging 或 outbound fetch；alpha handler 也不导入
CoinGecko、cache 或旧响应转换逻辑，candles handler 不导入 ccxt、选择 exchange 或转换 K 线。
futures handler 不初始化 Supabase、不聚合 funding/open-interest 行，也不请求 CoinGecko。
arbitrage handler 保留 dynamic 元数据，但不导入 ccxt、cache、logger、rate limit 或检测器；桌面卡只显示本地
`dataUnavailable`，不请求、不重试，也不把不可用说成市场均衡或无机会。
fear-greed handler 保留 Edge/dynamic 元数据，但不使用 cache、rate limit 或情绪供应商；仪表盘只显示本地
`dataUnavailable`，不请求、不重试，也不渲染过期数值、动画或历史图。
sparklines handler 保留 Edge/dynamic 元数据，但不使用内存缓存、rate limit 或 CoinGecko；SpotMarket 的
7D 单元格显示本地 `dataUnavailable` 标记，不发起该 endpoint 请求。
`/api/v1/cdn-proxy`、`/api/v1/market/alpha`、`/api/v1/market/arbitrage`、
`/api/v1/market/candles`、`/api/v1/market/futures`、`/api/v1/market/fear-greed`、
`/api/v1/market/sparklines` 和 `/api/v1/posts/link-preview` 只在 rewrite 前使用同一组 exact proxy
handoff，不扩展到相邻路径。独立的 Funding Rates 与 Open Interest 页面直接读取各自 RPC/回退数据，
不经此 retired handler，仍在本边界范围外。

这是 source-only handler contract，不能停止、检查或证明此前已部署代码、缓存内容、DNS 状态、
external host 或 exchange 的状态。群组编辑器这一已知 consumer 已在同一 V1 hold 中移除；其他未列
public egress consumer 仍须单独审查。

---

## 认证说明

| 标记           | 含义                               |
| -------------- | ---------------------------------- |
| **是**         | 需要登录（Bearer Token 或 Cookie） |
| **否**         | 无需登录                           |
| **可选**       | 登录后有更多数据                   |
| **管理员**     | 需要 admin 角色                    |
| **群管理员**   | 需要群组 owner/admin 角色          |
| **群成员**     | 需要是群组成员                     |
| **Pro 用户**   | 需要有效订阅                       |
| **Cron Token** | 需要 Vercel Cron 验证              |

---

最后更新: 2026-08-16
