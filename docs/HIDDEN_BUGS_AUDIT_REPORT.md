# 隐性破坏审计报告

**审计日期**: 2026-01-21
**审计员**: Claude Code
**项目**: Ranking Arena

---

## 执行摘要

本次审计发现 **5个CRITICAL级别安全漏洞**、**18+个静默错误点**、**5个半残功能**。

**结论**: 🚫 **不建议上线** - 存在严重的认证漏洞和数据一致性问题。

---

## 一、隐性破坏点（看起来能跑但已悄悄坏了）

### CRITICAL 级别

| # | 位置 | 问题 | 为什么不容易发现 | 后果 |
|---|------|------|------------------|------|
| 1 | `lib/cache/index.ts:351-353` | 缓存写入错误被静默吞掉 `.catch(() => {})` | 代码继续返回data，表面成功 | 缓存失效但无人知晓 |
| 2 | `app/api/conversations/route.ts:52-80` | Promise.all 内部查询无错误边界 | 单个查询失败导致整个列表为空 | 用户看到空消息列表 |
| 3 | `app/u/[handle]/page.tsx:455-461` | getTraderFeed 缺少 `.catch()` | 其他4个调用都有catch | 整个页面崩溃 |
| 4 | `app/api/posts/[id]/like/route.ts:32-42` | 点赞成功但元数据获取失败 | 数据库写入成功，API返回错误 | UI显示失败但实际已点赞 |
| 5 | `lib/stores/index.ts:105-115` | followTrader/unfollowTrader 竞态条件 | 快速点击时状态被覆盖 | 关注操作丢失 |

### HIGH 级别

| # | 位置 | 问题 | 后果 |
|---|------|------|------|
| 6 | `lib/hooks/useDataFetching.ts:219-232` | 缓存使用 stale state.data | 缓存与状态不一致 |
| 7 | `lib/hooks/useRealtime.ts:187-206` | retryCount 闭包过期 | 最大重试次数失效 |
| 8 | `app/api/translate/route.ts:302-330` | 批量翻译无错误隔离 | 部分翻译成功但全部返回错误 |
| 9 | `lib/stores/index.ts:353-387` | 缓存存储竞态条件 | 缓存损坏 |
| 10 | `lib/hooks/useOptimisticUpdate.ts:105-110` | 错误状态被静默清除 | 用户看不到错误 |

---

## 二、安全漏洞（权限错位）

### CRITICAL - 认证缺失

| 端点 | 问题 | 攻击方式 |
|-----|------|---------|
| `GET /api/messages` | 无认证检查 | 任何人可通过userId参数读取私信 |
| `POST /api/messages` | senderId来自请求body | 伪造身份发送消息 |
| `GET/POST /api/users/follow` | 无认证检查 | 代替他人关注/取消关注 |
| `POST /api/scrape/*` | 弱密钥验证 | 时序攻击可猜测CRON_SECRET |

### HIGH - 权限检查缺陷

| 端点 | 问题 |
|-----|------|
| `PATCH /api/groups/[id]/members/[userId]/role` | 无锁机制，可竞态绕过 |
| `POST /api/groups/applications/[id]/approve` | 仅检查user_profiles.role |
| `POST /api/exchange/authorize` | state参数未签名，可CSRF攻击 |

---

## 三、功能承诺完整性

### 半残功能列表

| 功能 | UI显示 | 实际状态 | 缺失部分 |
|------|--------|---------|----------|
| 交易员关注 | "关注"按钮 | 返回503 | `trader_follows`表不存在 |
| 用户关注 | 关注按钮 | 返回503 | `user_follows`表不存在 |
| 帖子图片上传 | 上传按钮 | 返回503 | `posts` bucket不存在 |
| 视频教程 | "即将上线"文字 | 无内容 | 仅占位符 |
| 转发统计 | repost_count字段 | 永远为0 | 触发器未写入reposts表 |

---

## 四、数据污染风险

| 污染源 | 位置 | 影响 |
|-------|------|------|
| 书签计数竞态 | `posts/[id]/bookmark/route.ts` | bookmark_count永久错误 |
| Schema不匹配 | scrape routes | 写入不存在的字段导致失败 |
| 两阶段写入无事务 | `scrape/binance/route.ts` | sources成功但snapshots失败 |
| 触发器缺失 | posts表 | like_count不更新 |

---

## 五、可观测性缺失

### 无法调试的失败点

| 操作 | 位置 | 问题 |
|-----|------|------|
| 浏览量统计 | `posts/[id]/route.ts:33-36` | 更新无错误检查 |
| 删除关联数据 | `posts/[id]/delete/route.ts:48-57` | 删评论/点赞无错误处理 |
| 消息已读标记 | `messages/route.ts:76-80` | 结果未检查 |
| 支付fallback | `stripe/webhook/route.ts:180-199` | upsert无错误处理 |
| Cron任务 | 多个文件 | 仅console.error，无Sentry |

---

## 六、用户"作死"路径

| 操作序列 | 结果 | 可恢复性 |
|---------|------|---------|
| 快速连点关注5次 | 状态随机 | ❌ 需刷新 |
| 点赞后立即刷新 | 乐观更新丢失 | ✅ 再次点赞 |
| 上传中关闭页面 | 孤儿文件 | ❌ 需手动清理 |
| 多标签页登录 | CSRF token不同步 | ✅ 刷新 |

---

## 七、高风险回归点

基于最近10次提交:

| 功能 | 改动文件 | 风险 |
|-----|---------|------|
| 图片上传 | `upload-image/route.ts` | bucket不存在时503 |
| 关注按钮 | `FollowButton.tsx` | table不存在时静默失败 |
| 图表组件 | `EquityCurve.tsx` | 重试逻辑可能累积状态 |

### 必须手测的10个动作

1. 图片上传 → 刷新 → 确认图片仍在
2. 关注交易员 → 刷新 → 确认状态保持
3. 发帖 → 查看 → 编辑 → 删除
4. 快速连点点赞3次 → 确认最终状态
5. 搜索 → 选择建议 → 返回 → 检查历史
6. 未登录访问收藏 → 登录 → 检查跳转
7. 图表超时 → 点击重试 → 确认有效
8. 打开对话 → 刷新 → 确认已读状态
9. 多端同时操作 → 检查状态同步
10. 支付发起 → 中途关闭 → 再次发起

---

## 八、上线决策

### 🚫 拒绝上线

| 致命问题 | 理由 |
|---------|------|
| 消息API无认证 | 任何人可读取/伪造私信 |
| 用户关注API无认证 | 可代替任何用户执行操作 |
| 书签计数竞态 | 数据永久污染 |
| 关注功能503但UI显示 | 功能承诺不兑现 |

---

## 九、立即行动清单

### P0 - 紧急（上线前必须修复）

1. **修复认证漏洞**
   - `app/api/messages/route.ts` - 添加认证检查
   - `app/api/users/follow/route.ts` - 添加认证检查

2. **创建缺失的数据库表**
   - 运行 `setup_trader_follows.sql`
   - 运行 `setup_posts_storage.sql`
   - 或禁用相关UI按钮

3. **添加错误监控**
   - 支付流程添加Sentry
   - 数据库写操作添加错误检查

### P1 - 高优先级

4. 修复竞态条件（stores/index.ts）
5. 修复Promise.all错误边界
6. 添加书签计数的数据库锁

---

## 十、项目风险评估

| 指标 | 当前值 | 健康值 | 状态 |
|-----|--------|--------|------|
| 功能半残率 | 5个 | 0 | 🔴 |
| 静默错误点 | 18+ | <5 | 🔴 |
| 权限漏洞 | 5个CRITICAL | 0 | 🔴 |
| 缺失DB表 | 2-3个 | 0 | 🟡 |

**风险等级**: 🔴 **HIGH - 已进入失控风险区**

---

*报告结束*
