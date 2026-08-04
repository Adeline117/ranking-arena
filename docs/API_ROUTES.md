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

| 路由                                  | 方法             | 描述                                                                                                | 认证 |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | ---- |
| `/api/traders`                        | GET              | 获取交易员列表                                                                                      | 可选 |
| `/api/traders/[handle]`               | GET              | 获取交易员基本信息                                                                                  | 否   |
| `/api/traders/[handle]/full`          | GET              | 获取交易员完整信息                                                                                  | 否   |
| `/api/traders/[handle]/equity`        | GET              | 获取权益曲线数据                                                                                    | 否   |
| `/api/traders/[handle]/positions`     | GET              | 获取持仓信息                                                                                        | 否   |
| `/api/traders/[handle]/percentile`    | GET              | 获取排名百分位                                                                                      | 否   |
| `/api/traders/claim`                  | GET/POST         | 查询认领状态；提交 Hyperliquid/GMX V2 wallet-signature 认领并进入人工审核                           | 是   |
| `/api/traders/claim/wallet-challenge` | POST             | 签发绑定用户/来源/trader/domain/nonce/expiry 的一次性钱包 challenge；Redis 不可用时 503 fail closed | 是   |
| `/api/traders/claim/verify-wallet`    | POST             | 旧预验证入口；匿名先返回 401，已登录返回 410，且不读取 body、消费 nonce 或写数据库                  | 是   |
| `/api/traders/linked`                 | GET/PATCH/DELETE | 管理已绑定身份；DELETE 使用 service-only 原子解绑 RPC                                               | 是   |
| `/api/compare`                        | GET              | 对比交易员                                                                                          | 可选 |
| `/api/market`                         | GET              | 获取市场数据                                                                                        | 否   |

`DELETE /api/traders/linked` 不只是删除一条链接：它在同一事务内把对应 verified claim 转为终态审计记录，移除 `verified_traders`/用户链接的公开 badge 权威，重算主身份与用户资料，并清除 Arena claimed 状态。只有来源、交易员 UID 与 canonical exchange 都能精确对应时，才同时停用 CEX connection 并撤销匹配 authorization；投影漂移会原子失败，无法证明的 legacy credential mapping 不做猜测，必须进入 owner 人工审计门禁。旧 `/api/traders/claim/verify-wallet` 是 auth-first tombstone：匿名请求返回 401，已登录请求返回 410；两种路径都 fail closed，且没有凭据读取、proof consumption、direct-table fallback 或写入。

---

## 2. 用户管理

| 路由                                   | 方法     | 描述                 | 认证 |
| -------------------------------------- | -------- | -------------------- | ---- |
| `/api/users/[handle]/full`             | GET      | 获取用户完整资料     | 否   |
| `/api/users/[handle]/following`        | GET      | 获取用户关注列表     | 否   |
| `/api/users/[handle]/followers`        | GET      | 获取用户粉丝列表     | 否   |
| `/api/users/[handle]/bookmark-folders` | GET      | 获取用户收藏夹       | 否   |
| `/api/users/follow`                    | POST     | 关注/取关用户        | 是   |
| `/api/follow`                          | POST     | 关注操作             | 是   |
| `/api/following`                       | GET      | 获取当前用户关注列表 | 是   |
| `/api/avatar`                          | POST     | 上传头像             | 是   |
| `/api/avoid-list`                      | GET/POST | 屏蔽列表管理         | 是   |

---

## 3. 帖子与社交

| 路由                            | 方法     | 描述            | 认证     |
| ------------------------------- | -------- | --------------- | -------- |
| `/api/posts`                    | GET/POST | 帖子列表/发帖   | POST: 是 |
| `/api/posts/[id]`               | GET      | 获取帖子详情    | 否       |
| `/api/posts/[id]/edit`          | PUT      | 编辑帖子        | 是       |
| `/api/posts/[id]/delete`        | DELETE   | 删除帖子        | 是       |
| `/api/posts/[id]/like`          | POST     | 点赞帖子        | 是       |
| `/api/posts/[id]/vote`          | POST     | 投票（赞/踩）   | 是       |
| `/api/posts/[id]/poll-vote`     | POST     | 投票帖子选项    | 是       |
| `/api/posts/[id]/bookmark`      | POST     | 收藏帖子        | 是       |
| `/api/posts/[id]/repost`        | POST     | 转发帖子        | 是       |
| `/api/posts/[id]/pin`           | POST     | 置顶帖子        | 是       |
| `/api/posts/[id]/comments`      | GET/POST | 评论列表/发评论 | POST: 是 |
| `/api/posts/[id]/comments/like` | POST     | 点赞评论        | 是       |
| `/api/posts/bookmarks/status`   | GET      | 检查收藏状态    | 是       |
| `/api/posts/link-preview`       | GET      | 获取链接预览    | 否       |
| `/api/posts/upload-image`       | POST     | 上传图片        | 是       |
| `/api/posts/upload-video`       | POST     | 上传视频        | 是       |

### 收藏夹

| 路由                                   | 方法       | 描述            | 认证 |
| -------------------------------------- | ---------- | --------------- | ---- |
| `/api/bookmark-folders`                | GET/POST   | 收藏夹列表/创建 | 是   |
| `/api/bookmark-folders/[id]`           | PUT/DELETE | 更新/删除收藏夹 | 是   |
| `/api/bookmark-folders/[id]/subscribe` | POST       | 订阅收藏夹      | 是   |
| `/api/bookmark-folders/subscribed`     | GET        | 已订阅收藏夹    | 是   |

---

## 4. 群组管理

### 群组操作

| 路由                                    | 方法 | 描述          | 认证   |
| --------------------------------------- | ---- | ------------- | ------ |
| `/api/groups/subscribe`                 | POST | 加入/退出群组 | 是     |
| `/api/groups/apply`                     | POST | 申请创建群组  | 是     |
| `/api/groups/applications`              | GET  | 群组申请列表  | 是     |
| `/api/groups/applications/[id]/approve` | POST | 批准创建申请  | 管理员 |
| `/api/groups/applications/[id]/reject`  | POST | 拒绝创建申请  | 管理员 |

### 群组编辑

| 路由                                         | 方法 | 描述         | 认证   |
| -------------------------------------------- | ---- | ------------ | ------ |
| `/api/groups/[id]/edit-apply`                | POST | 申请编辑群组 | 群主   |
| `/api/groups/edit-applications`              | GET  | 编辑申请列表 | 管理员 |
| `/api/groups/edit-applications/[id]/approve` | POST | 批准编辑申请 | 管理员 |
| `/api/groups/edit-applications/[id]/reject`  | POST | 拒绝编辑申请 | 管理员 |

### 成员管理

| 路由                                     | 方法 | 描述         | 认证     |
| ---------------------------------------- | ---- | ------------ | -------- |
| `/api/groups/[id]/members/[userId]/mute` | POST | 禁言成员     | 群管理员 |
| `/api/groups/[id]/members/[userId]/role` | PUT  | 更改成员角色 | 群主     |

### 内容管理

| 路由                                           | 方法   | 描述         | 认证     |
| ---------------------------------------------- | ------ | ------------ | -------- |
| `/api/groups/[id]/posts/[postId]/delete`       | DELETE | 删除群内帖子 | 群管理员 |
| `/api/groups/[id]/comments/[commentId]/delete` | DELETE | 删除群内评论 | 群管理员 |

### 投诉与选举

| 路由                                             | 方法     | 描述              | 认证     |
| ------------------------------------------------ | -------- | ----------------- | -------- |
| `/api/groups/[id]/complaints`                    | GET/POST | 投诉列表/发起投诉 | 群成员   |
| `/api/groups/[id]/complaints/[complaintId]/vote` | POST     | 投诉投票          | 群成员   |
| `/api/groups/[id]/leader-election`               | GET      | 选举状态          | 群成员   |
| `/api/groups/[id]/leader-election/start-voting`  | POST     | 发起选举          | 群管理员 |
| `/api/groups/[id]/leader-election/vote`          | POST     | 选举投票          | 群成员   |

### Pro 群组

| 路由                      | 方法 | 描述             | 认证     |
| ------------------------- | ---- | ---------------- | -------- |
| `/api/pro-official-group` | GET  | Pro 官方群组列表 | Pro 用户 |

---

## 5. 私信系统

| 路由                  | 方法     | 描述            | 认证 |
| --------------------- | -------- | --------------- | ---- |
| `/api/conversations`  | GET      | 会话列表        | 是   |
| `/api/messages`       | GET/POST | 消息列表/发消息 | 是   |
| `/api/messages/start` | POST     | 开始新会话      | 是   |

---

## 6. 支付与订阅

| 路由                          | 方法 | 描述                  | 认证          |
| ----------------------------- | ---- | --------------------- | ------------- |
| `/api/stripe/create-checkout` | POST | 创建支付会话          | 是            |
| `/api/stripe/verify-session`  | GET  | 验证支付状态          | 是            |
| `/api/stripe/portal`          | POST | 客户管理门户          | 是            |
| `/api/stripe/webhook`         | POST | Stripe Webhook        | 否 (签名验证) |
| `/api/webhook/stripe`         | POST | Stripe Webhook (备用) | 否            |
| `/api/subscription`           | GET  | 订阅状态              | 是            |
| `/api/checkout`               | POST | 一次性支付            | 是            |
| `/api/tip`                    | POST | 打赏                  | 是            |
| `/api/tip/checkout`           | POST | 打赏支付              | 是            |

---

## 7. 通知与预警

| 路由                           | 方法    | 描述         | 认证 |
| ------------------------------ | ------- | ------------ | ---- |
| `/api/notifications`           | GET     | 通知列表     | 是   |
| `/api/notifications/mark-read` | POST    | 标记已读     | 是   |
| `/api/push/subscribe`          | POST    | 推送订阅     | 是   |
| `/api/risk-alerts`             | GET     | 风险预警列表 | 是   |
| `/api/risk-alerts/config`      | GET/PUT | 预警配置     | 是   |
| `/api/trader-alerts`           | GET     | 交易员预警   | 是   |

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
| `/api/portfolio/suggestions`              | GET    | 基于公开交易员数据的组合建议；与旧 CEX 凭据表无关                                            | 可选 / Pro |
| `/api/cron/aggregate-portfolio-snapshots` | GET    | 认证 compatibility no-op；返回 `status=retired`、`snapshots=0`，且不在 Vercel schedule 中    | Cron Token |

所有响应均不得暴露旧 API key 密文。`POST /api/settings/export` 不接受 caller-supplied user id；server 只把已认证 user id 传给 service-only `export_legacy_portfolio_data_v1(uuid)`。输出键为 `account.legacy_portfolios = { portfolios, positions, snapshots }`，manifest 对应三个同名前缀数据集；每组最多 250,000 行。portfolio 只含 `id/exchange/label/created_at`，positions 与 snapshots 只含用户可移植的严格白名单业务字段，numeric 以 text 保真；不含 `user_id` 或任何 API key/passphrase ciphertext，child `portfolio_id` 必须属于同一 owner 的导出 parent set。exact bridge SHA 会早于 Portfolio migration 部署，因此 migration 前已认证 export 必须返回 500 fail closed，不能降级为省略 `legacy_portfolios` 的“成功”导出；migration 后才以 HTTP 200、完整三项 manifest/owner rows、零密文/跨 owner 数据及每组超限返回 413 作为可用证明。Arena owner-delete 只清除 Arena 副本及其 child rows，不会调用交易所撤销 key；用户必须另在对应交易所 revoke/rotate。migration 部署后 production 必须核对 exact ledger、三表 table/column ACL、唯一 service metadata policy、两个 service-only RPC、数据保留、export owner scope/字段白名单/上限、跨 owner delete false、delete cascade 与 rollback。

---

## 9. 定时任务 (Cron)

| 路由                                      | 方法 | 描述                                                                | 认证       |
| ----------------------------------------- | ---- | ------------------------------------------------------------------- | ---------- |
| `/api/cron/fetch-traders`                 | GET  | 获取交易员数据                                                      | Cron Token |
| `/api/cron/fetch-traders/[platform]`      | GET  | 按平台获取                                                          | Cron Token |
| `/api/cron/fetch-details`                 | GET  | 获取详细数据                                                        | Cron Token |
| `/api/cron/fetch-followed-traders`        | GET  | 更新关注交易员                                                      | Cron Token |
| `/api/cron/fetch-hot-traders`             | GET  | 更新热门交易员                                                      | Cron Token |
| `/api/cron/check-trader-alerts`           | GET  | 检查交易员预警                                                      | Cron Token |
| `/api/cron/check-data-freshness`          | GET  | 检查数据新鲜度                                                      | Cron Token |
| `/api/cron/sync-authorized-traders`       | GET  | V1 兼容认证 no-op；不扫描授权、不创建公共 first-party 作业          | Cron Token |
| `/api/cron/aggregate-portfolio-snapshots` | GET  | V1 兼容认证 no-op；不读取旧凭据、不写 snapshots，且未被 Vercel 调度 | Cron Token |
| `/api/cron/trigger-fetch`                 | POST | 手动触发抓取                                                        | 管理员     |

---

## 10. 管理后台

| 路由                              | 方法    | 描述                                                                   | 认证                |
| --------------------------------- | ------- | ---------------------------------------------------------------------- | ------------------- |
| `/api/admin/users`                | GET     | 用户列表                                                               | 管理员              |
| `/api/admin/users/[id]/ban`       | POST    | 封禁用户                                                               | 管理员              |
| `/api/admin/users/[id]/unban`     | POST    | 解封用户                                                               | 管理员              |
| `/api/admin/reports`              | GET     | 举报列表                                                               | 管理员              |
| `/api/admin/reports/[id]/resolve` | POST    | 处理举报                                                               | 管理员              |
| `/api/admin/alert-config`         | GET/PUT | 预警配置                                                               | 管理员              |
| `/api/admin/stats`                | GET     | 系统统计                                                               | 管理员              |
| `/api/admin/data-report`          | GET     | 数据报告                                                               | 管理员              |
| `/api/admin/data-freshness`       | GET     | registry + serving board + `source_as_of` 权威新鲜度（只读、不发告警） | 管理员 / Cron Token |
| `/api/admin/import-binance`       | POST    | 导入 Binance 数据                                                      | 管理员              |
| `/api/monitoring/freshness`       | GET     | 已退役旧 contract；认证后返回 410 与 successor link                    | 管理员 / Cron Token |

---

## 11. 工具与其他

| 路由                         | 方法     | 描述                                                                  | 认证      |
| ---------------------------- | -------- | --------------------------------------------------------------------- | --------- |
| `/api/health`                | GET      | 健康检查                                                              | 否        |
| `/api/health/detailed`       | GET      | 详细健康状态                                                          | 否        |
| `/api/docs`                  | GET      | API 文档 (OpenAPI)                                                    | 否        |
| `/api/translate`             | POST     | 翻译服务                                                              | 是        |
| `/api/translate/test`        | GET      | 翻译测试                                                              | 否        |
| `/api/settings/export`       | POST     | 当前用户可移植数据导出（24 小时一次，含无密文 legacy Portfolio 数据） | 是 + CSRF |
| `/api/saved-filters`         | GET/POST | 保存筛选条件                                                          | 是        |
| `/api/search/suggestions`    | GET      | 搜索建议                                                              | 否        |
| `/api/portfolio/suggestions` | GET      | 投资组合建议                                                          | 是        |

### 抓取工具（内部）

| 路由                  | 方法 | 描述              | 认证   |
| --------------------- | ---- | ----------------- | ------ |
| `/api/scrape/binance` | GET  | 抓取 Binance      | 管理员 |
| `/api/scrape/mexc`    | GET  | 抓取 MEXC         | 管理员 |
| `/api/scrape/trigger` | POST | 触发抓取          | 管理员 |
| `/api/test-binance`   | GET  | 测试 Binance 连接 | 管理员 |

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

最后更新: 2026-08-03
