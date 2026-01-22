# API 路由文档

**总计**: 113 个 API 端点

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

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/traders` | GET | 获取交易员列表 | 可选 |
| `/api/traders/[handle]` | GET | 获取交易员基本信息 | 否 |
| `/api/traders/[handle]/full` | GET | 获取交易员完整信息 | 否 |
| `/api/traders/[handle]/equity` | GET | 获取权益曲线数据 | 否 |
| `/api/traders/[handle]/positions` | GET | 获取持仓信息 | 否 |
| `/api/traders/[handle]/percentile` | GET | 获取排名百分位 | 否 |
| `/api/traders/claim` | POST | 认领交易员身份 | 是 |
| `/api/compare` | GET | 对比交易员 | 可选 |
| `/api/market` | GET | 获取市场数据 | 否 |

---

## 2. 用户管理

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/users/[handle]/full` | GET | 获取用户完整资料 | 否 |
| `/api/users/[handle]/following` | GET | 获取用户关注列表 | 否 |
| `/api/users/[handle]/followers` | GET | 获取用户粉丝列表 | 否 |
| `/api/users/[handle]/bookmark-folders` | GET | 获取用户收藏夹 | 否 |
| `/api/users/follow` | POST | 关注/取关用户 | 是 |
| `/api/follow` | POST | 关注操作 | 是 |
| `/api/following` | GET | 获取当前用户关注列表 | 是 |
| `/api/avatar` | POST | 上传头像 | 是 |
| `/api/avoid-list` | GET/POST | 屏蔽列表管理 | 是 |

---

## 3. 帖子与社交

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/posts` | GET/POST | 帖子列表/发帖 | POST: 是 |
| `/api/posts/[id]` | GET | 获取帖子详情 | 否 |
| `/api/posts/[id]/edit` | PUT | 编辑帖子 | 是 |
| `/api/posts/[id]/delete` | DELETE | 删除帖子 | 是 |
| `/api/posts/[id]/like` | POST | 点赞帖子 | 是 |
| `/api/posts/[id]/vote` | POST | 投票（赞/踩） | 是 |
| `/api/posts/[id]/poll-vote` | POST | 投票帖子选项 | 是 |
| `/api/posts/[id]/bookmark` | POST | 收藏帖子 | 是 |
| `/api/posts/[id]/repost` | POST | 转发帖子 | 是 |
| `/api/posts/[id]/pin` | POST | 置顶帖子 | 是 |
| `/api/posts/[id]/comments` | GET/POST | 评论列表/发评论 | POST: 是 |
| `/api/posts/[id]/comments/like` | POST | 点赞评论 | 是 |
| `/api/posts/bookmarks/status` | GET | 检查收藏状态 | 是 |
| `/api/posts/link-preview` | GET | 获取链接预览 | 否 |
| `/api/posts/upload-image` | POST | 上传图片 | 是 |
| `/api/posts/upload-video` | POST | 上传视频 | 是 |

### 收藏夹

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/bookmark-folders` | GET/POST | 收藏夹列表/创建 | 是 |
| `/api/bookmark-folders/[id]` | PUT/DELETE | 更新/删除收藏夹 | 是 |
| `/api/bookmark-folders/[id]/subscribe` | POST | 订阅收藏夹 | 是 |
| `/api/bookmark-folders/subscribed` | GET | 已订阅收藏夹 | 是 |

---

## 4. 群组管理

### 群组操作

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/groups/subscribe` | POST | 加入/退出群组 | 是 |
| `/api/groups/apply` | POST | 申请创建群组 | 是 |
| `/api/groups/applications` | GET | 群组申请列表 | 是 |
| `/api/groups/applications/[id]/approve` | POST | 批准创建申请 | 管理员 |
| `/api/groups/applications/[id]/reject` | POST | 拒绝创建申请 | 管理员 |

### 群组编辑

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/groups/[id]/edit-apply` | POST | 申请编辑群组 | 群主 |
| `/api/groups/edit-applications` | GET | 编辑申请列表 | 管理员 |
| `/api/groups/edit-applications/[id]/approve` | POST | 批准编辑申请 | 管理员 |
| `/api/groups/edit-applications/[id]/reject` | POST | 拒绝编辑申请 | 管理员 |

### 成员管理

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/groups/[id]/members/[userId]/mute` | POST | 禁言成员 | 群管理员 |
| `/api/groups/[id]/members/[userId]/role` | PUT | 更改成员角色 | 群主 |

### 内容管理

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/groups/[id]/posts/[postId]/delete` | DELETE | 删除群内帖子 | 群管理员 |
| `/api/groups/[id]/comments/[commentId]/delete` | DELETE | 删除群内评论 | 群管理员 |

### 投诉与选举

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/groups/[id]/complaints` | GET/POST | 投诉列表/发起投诉 | 群成员 |
| `/api/groups/[id]/complaints/[complaintId]/vote` | POST | 投诉投票 | 群成员 |
| `/api/groups/[id]/leader-election` | GET | 选举状态 | 群成员 |
| `/api/groups/[id]/leader-election/start-voting` | POST | 发起选举 | 群管理员 |
| `/api/groups/[id]/leader-election/vote` | POST | 选举投票 | 群成员 |

### Pro 群组

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/pro-official-group` | GET | Pro 官方群组列表 | Pro 用户 |

---

## 5. 私信系统

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/conversations` | GET | 会话列表 | 是 |
| `/api/messages` | GET/POST | 消息列表/发消息 | 是 |
| `/api/messages/start` | POST | 开始新会话 | 是 |

---

## 6. 支付与订阅

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/stripe/create-checkout` | POST | 创建支付会话 | 是 |
| `/api/stripe/verify-session` | GET | 验证支付状态 | 是 |
| `/api/stripe/portal` | POST | 客户管理门户 | 是 |
| `/api/stripe/webhook` | POST | Stripe Webhook | 否 (签名验证) |
| `/api/webhook/stripe` | POST | Stripe Webhook (备用) | 否 |
| `/api/subscription` | GET | 订阅状态 | 是 |
| `/api/checkout` | POST | 一次性支付 | 是 |
| `/api/tip` | POST | 打赏 | 是 |
| `/api/tip/checkout` | POST | 打赏支付 | 是 |

---

## 7. 通知与预警

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/notifications` | GET | 通知列表 | 是 |
| `/api/notifications/mark-read` | POST | 标记已读 | 是 |
| `/api/push/subscribe` | POST | 推送订阅 | 是 |
| `/api/risk-alerts` | GET | 风险预警列表 | 是 |
| `/api/risk-alerts/config` | GET/PUT | 预警配置 | 是 |
| `/api/trader-alerts` | GET | 交易员预警 | 是 |

---

## 8. 交易所绑定

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/exchange/connect` | POST | 连接交易所 | 是 |
| `/api/exchange/disconnect` | POST | 断开连接 | 是 |
| `/api/exchange/authorize` | POST | 授权 | 是 |
| `/api/exchange/verify-ownership` | POST | 验证所有权 | 是 |
| `/api/exchange/sync` | POST | 同步数据 | 是 |
| `/api/exchange/oauth/authorize` | GET | OAuth 授权 | 是 |
| `/api/exchange/oauth/callback` | GET | OAuth 回调 | - |
| `/api/exchange/oauth/refresh` | POST | 刷新 Token | 是 |

---

## 9. 定时任务 (Cron)

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/cron/fetch-traders` | GET | 获取交易员数据 | Cron Token |
| `/api/cron/fetch-traders/[platform]` | GET | 按平台获取 | Cron Token |
| `/api/cron/fetch-details` | GET | 获取详细数据 | Cron Token |
| `/api/cron/fetch-followed-traders` | GET | 更新关注交易员 | Cron Token |
| `/api/cron/fetch-hot-traders` | GET | 更新热门交易员 | Cron Token |
| `/api/cron/check-trader-alerts` | GET | 检查交易员预警 | Cron Token |
| `/api/cron/check-data-freshness` | GET | 检查数据新鲜度 | Cron Token |
| `/api/cron/trigger-fetch` | POST | 手动触发抓取 | 管理员 |

---

## 10. 管理后台

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/admin/users` | GET | 用户列表 | 管理员 |
| `/api/admin/users/[id]/ban` | POST | 封禁用户 | 管理员 |
| `/api/admin/users/[id]/unban` | POST | 解封用户 | 管理员 |
| `/api/admin/reports` | GET | 举报列表 | 管理员 |
| `/api/admin/reports/[id]/resolve` | POST | 处理举报 | 管理员 |
| `/api/admin/alert-config` | GET/PUT | 预警配置 | 管理员 |
| `/api/admin/stats` | GET | 系统统计 | 管理员 |
| `/api/admin/data-report` | GET | 数据报告 | 管理员 |
| `/api/admin/import-binance` | POST | 导入 Binance 数据 | 管理员 |

---

## 11. 工具与其他

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/health` | GET | 健康检查 | 否 |
| `/api/health/detailed` | GET | 详细健康状态 | 否 |
| `/api/docs` | GET | API 文档 (OpenAPI) | 否 |
| `/api/translate` | POST | 翻译服务 | 是 |
| `/api/translate/test` | GET | 翻译测试 | 否 |
| `/api/export` | GET | 数据导出 | 是 |
| `/api/saved-filters` | GET/POST | 保存筛选条件 | 是 |
| `/api/search/suggestions` | GET | 搜索建议 | 否 |
| `/api/portfolio/suggestions` | GET | 投资组合建议 | 是 |

### 抓取工具（内部）

| 路由 | 方法 | 描述 | 认证 |
|------|------|------|------|
| `/api/scrape/binance` | GET | 抓取 Binance | 管理员 |
| `/api/scrape/mexc` | GET | 抓取 MEXC | 管理员 |
| `/api/scrape/trigger` | POST | 触发抓取 | 管理员 |
| `/api/test-binance` | GET | 测试 Binance 连接 | 管理员 |

---

## 认证说明

| 标记 | 含义 |
|------|------|
| **是** | 需要登录（Bearer Token 或 Cookie） |
| **否** | 无需登录 |
| **可选** | 登录后有更多数据 |
| **管理员** | 需要 admin 角色 |
| **群管理员** | 需要群组 owner/admin 角色 |
| **群成员** | 需要是群组成员 |
| **Pro 用户** | 需要有效订阅 |
| **Cron Token** | 需要 Vercel Cron 验证 |

---

最后更新: 2026-01-21
