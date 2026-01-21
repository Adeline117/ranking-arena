# 付费链路 QA 测试用例文档

> 版本: 1.0.0
> 更新日期: 2026-01-21
> 目标: 付费链路零功能问题

---

## 项目背景

- **订阅层级**: Free / Pro
- **支付渠道**: Stripe
- **前端框架**: Next.js 16 (App Router)
- **后端**: Supabase (Auth/DB) + Stripe Webhooks
- **价格**:
  - Pro Monthly: $9.99/月
  - Pro Yearly: $99.99/年 (省 17%)

---

## A. 付费链路端到端用例

### 【用例 P-001】未登录用户点击 Pro 升级按钮

- **前置条件**: 用户未登录状态
- **操作步骤**:
  1. 访问首页或任意含 Paywall 组件的页面
  2. 点击"升级 Pro"按钮
- **期望 UI 结果**: 弹出登录/注册模态框，而非直接跳转 Stripe
- **期望后端结果**: 无 API 调用
- **期望权限结果**: 用户仍为游客状态
- **失败时应提示**: "请先登录"
- **严重程度**: 致命

---

### 【用例 P-002】Free 用户完整购买 Pro Monthly 流程

- **前置条件**:
  - 用户已登录，`user_profiles.subscription_tier = 'free'`
  - `subscriptions` 表无该用户记录
- **操作步骤**:
  1. 点击"升级 Pro"按钮
  2. 选择"月付 $9.99"选项
  3. 跳转 Stripe Checkout
  4. 使用测试卡 `4242424242424242` 完成支付
  5. 等待重定向回应用
- **期望 UI 结果**:
  - 显示"订阅成功"Toast
  - 页面刷新后显示 Pro 徽章
  - Paywall 遮罩消失
- **期望后端结果**:
  - `subscriptions` 表新增记录: `tier='pro', status='active', plan='monthly'`
  - `user_profiles.subscription_tier = 'pro'`
  - `payment_history` 记录 `status='succeeded', amount=999`
- **期望权限结果**: 所有 14 项 Pro 功能可用
- **失败时应提示**: "订阅创建失败，请联系客服"
- **严重程度**: 致命

---

### 【用例 P-003】Free 用户购买 Pro Yearly 流程

- **前置条件**: 同 P-002
- **操作步骤**:
  1. 点击"升级 Pro"
  2. 选择"年付 $99.99（省 17%）"
  3. 完成 Stripe 支付
- **期望后端结果**:
  - `subscriptions.plan = 'yearly'`
  - `current_period_end` 为一年后
  - `payment_history.amount = 9999`
- **严重程度**: 致命

---

### 【用例 P-004】Pro 用户访问受限功能 - Trader Comparison

- **前置条件**: `user_profiles.subscription_tier = 'pro'`
- **操作步骤**:
  1. 访问交易员对比页面
  2. 选择 2 个交易员进行对比
  3. 点击"生成对比报告"
- **期望 UI 结果**: 正常显示对比图表和数据
- **期望后端结果**:
  - `/api/compare` 返回 200
  - 该用户本月 `comparisonReportsThisMonth` +1
- **期望权限结果**: 功能正常使用
- **严重程度**: 高

---

### 【用例 P-005】Free 用户访问 Pro 功能 - Advanced Filter

- **前置条件**: `user_profiles.subscription_tier = 'free'`
- **操作步骤**:
  1. 访问排行榜页面
  2. 点击"高级筛选"按钮
- **期望 UI 结果**:
  - 显示 Paywall 遮罩
  - 显示"升级 Pro 解锁多条件筛选"
  - 显示价格和升级按钮
- **期望后端结果**: 不触发筛选 API
- **期望权限结果**: 功能不可用
- **失败时应提示**: 无（直接显示 Paywall）
- **严重程度**: 高

---

### 【用例 P-006】Pro 用户取消订阅（期末取消）

- **前置条件**: `subscriptions.status = 'active'`
- **操作步骤**:
  1. 进入"账户设置" → "订阅管理"
  2. 点击"取消订阅"
  3. 选择"在当前周期结束后取消"
  4. 确认取消
- **期望 UI 结果**:
  - 显示"订阅将在 [日期] 到期"
  - 继续显示 Pro 徽章直到到期
- **期望后端结果**:
  - `subscriptions.cancel_at_period_end = true`
  - `subscriptions.status` 仍为 `'active'`
  - Stripe subscription 同步更新
- **期望权限结果**: 到期前保持 Pro 权限
- **严重程度**: 高

---

### 【用例 P-007】Pro 用户订阅到期后降级

- **前置条件**:
  - `subscriptions.cancel_at_period_end = true`
  - `current_period_end` 已过
- **操作步骤**:
  1. Stripe 触发 `customer.subscription.deleted` webhook
  2. 用户刷新页面
- **期望 UI 结果**:
  - Pro 徽章消失
  - Pro 功能显示 Paywall
- **期望后端结果**:
  - `subscriptions.status = 'canceled'` 或 `'expired'`
  - `user_profiles.subscription_tier = 'free'`
- **期望权限结果**: 降为 Free 限制
- **严重程度**: 致命

---

### 【用例 P-008】已取消用户重新订阅

- **前置条件**: `subscriptions.status = 'canceled'`
- **操作步骤**:
  1. 点击"重新订阅"
  2. 完成 Stripe 支付
- **期望后端结果**:
  - `subscriptions.status = 'active'`
  - 新的 `current_period_start/end`
  - `user_profiles.subscription_tier = 'pro'`
- **严重程度**: 高

---

### 【用例 P-009】Pro 用户自动续费成功

- **前置条件**:
  - `subscriptions.status = 'active'`
  - `cancel_at_period_end = false`
  - `current_period_end` 即将到期
- **操作步骤**:
  1. Stripe 自动扣款成功
  2. 触发 `invoice.payment_succeeded` webhook
- **期望后端结果**:
  - `current_period_end` 延长一个周期
  - `payment_history` 新增成功记录
  - 用户权限不变
- **严重程度**: 致命

---

### 【用例 P-010】自动续费失败 - 卡片过期

- **前置条件**: 用户支付卡片已过期
- **操作步骤**:
  1. Stripe 扣款失败
  2. 触发 `invoice.payment_failed` webhook
- **期望 UI 结果**:
  - 发送邮件通知用户更新支付方式
  - 用户登录后显示警告横幅
- **期望后端结果**:
  - `subscriptions.status = 'past_due'`
  - `payment_history` 记录 `status='failed'`
- **期望权限结果**: 宽限期内保持 Pro 权限（建议 3 天）
- **严重程度**: 致命

---

## B. 权限矩阵

| 功能 | Free 可见 | Free 可点 | Free 可用 | Pro 可见 | Pro 可点 | Pro 可用 |
|------|-----------|-----------|-----------|----------|----------|----------|
| 排行榜浏览 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 基础筛选 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 高级筛选 (advanced_filter) | ✅ | ✅ | ❌ Paywall | ✅ | ✅ | ✅ |
| 交易员详情 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Arena Score 详情 (score_breakdown) | ✅ | ✅ | ❌ 模糊 | ✅ | ✅ | ✅ |
| 交易员对比 (trader_comparison) | ✅ | ✅ | ❌ Paywall | ✅ | ✅ | ✅ (10次/月) |
| 关注交易员 | ✅ | ✅ | ✅ (10人上限) | ✅ | ✅ | ✅ (50人上限) |
| 历史数据 (historical_data) | ✅ | ✅ | ✅ (7天) | ✅ | ✅ | ✅ (90天) |
| 数据导出 (export_data) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ (10次/月) |
| 分类排行 (category_ranking) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| 邮件通知 (email_notifications) | ❌ | - | - | ✅ | ✅ | ✅ |
| 推送通知 (push_notifications) | ❌ | - | - | ✅ | ✅ | ✅ |
| 交易员提醒 (trader_alerts) | ❌ | - | - | ✅ | ✅ | ✅ |
| 自定义排行 (custom_rankings) | ❌ | - | - | ✅ | ✅ | ✅ |
| API 访问 (api_access) | ❌ | - | - | ✅ | ✅ | ✅ (1000次/日) |
| Pro 徽章 (pro_badge) | ❌ | - | - | ✅ | - | ✅ |
| Pro 专属群组 (premium_groups) | ❌ | - | - | ✅ | ✅ | ✅ |
| 投资组合建议 (portfolio_suggestions) | ❌ | - | - | ✅ | ✅ | ✅ |

---

## C. 反作弊/边界用例

### 【用例 E-001】重复点击支付按钮

- **前置条件**: 用户在 Stripe Checkout 页面
- **操作步骤**: 快速连续点击"支付"按钮 5 次
- **期望 UI 结果**: 第一次点击后按钮 disabled，显示 loading
- **期望后端结果**: 仅创建 1 个 subscription
- **失败时应提示**: "处理中，请稍候"
- **严重程度**: 致命

---

### 【用例 E-002】支付过程中网络中断

- **前置条件**: 用户在 Stripe 输入卡号后
- **操作步骤**: 点击支付后立即断开网络
- **期望 UI 结果**: 恢复网络后显示明确状态（成功/失败）
- **期望后端结果**: 通过 `/api/stripe/verify-session` 同步最终状态
- **严重程度**: 高

---

### 【用例 E-003】Webhook 延迟 30 秒以上

- **前置条件**: 用户完成支付，Webhook 未到达
- **操作步骤**:
  1. 用户支付成功
  2. 重定向回应用
  3. 前端调用 `/api/stripe/verify-session`
- **期望 UI 结果**: 显示"正在确认订阅状态..."，最终显示成功
- **期望后端结果**: verify-session 主动查询 Stripe 并更新数据库
- **严重程度**: 高

---

### 【用例 E-004】Webhook 重复投递

- **前置条件**: 同一 event 被 Stripe 投递 2 次
- **操作步骤**: 接收重复的 `checkout.session.completed`
- **期望后端结果**:
  - 第一次正常处理
  - 第二次幂等跳过（通过 event_id 检查）
  - `subscriptions` 表仅 1 条记录
- **严重程度**: 高

---

### 【用例 E-005】多设备同时登录

- **前置条件**: 用户在设备A是 Free，设备B刚完成 Pro 购买
- **操作步骤**: 设备A刷新页面
- **期望 UI 结果**: 设备A也显示 Pro 状态
- **期望后端结果**: 权限通过 API 实时验证，不依赖本地缓存
- **严重程度**: 高

---

### 【用例 E-006】篡改前端显示 Pro 状态

- **前置条件**: Free 用户通过 DevTools 修改 localStorage
- **操作步骤**: 尝试访问 `/api/compare`
- **期望后端结果**: 返回 403，提示"此功能需要 Pro 会员"
- **期望权限结果**: 后端 RLS/服务端校验拒绝
- **严重程度**: 致命

---

### 【用例 E-007】Stripe Refund 处理

- **前置条件**: Pro 用户请求退款
- **操作步骤**: 管理员在 Stripe Dashboard 执行全额退款
- **期望后端结果**:
  - Webhook `charge.refunded` 触发
  - `subscriptions.status = 'canceled'`
  - `user_profiles.subscription_tier = 'free'`
  - `payment_history` 记录 `status='refunded'`
- **期望权限结果**: 立即降为 Free
- **严重程度**: 高

---

### 【用例 E-008】卡片验证失败（3DS 挑战失败）

- **前置条件**: 用户使用需要 3DS 验证的卡
- **操作步骤**: 在 3DS 弹窗中点击"取消"或验证失败
- **期望 UI 结果**: 显示"支付验证失败，请重试"
- **期望后端结果**: `subscriptions` 表无新记录
- **严重程度**: 中

---

### 【用例 E-009】货币转换场景

- **前置条件**: 用户使用非 USD 货币卡
- **操作步骤**: 完成支付
- **期望后端结果**: `payment_history.currency = 'usd'`，金额正确（以美分计）
- **严重程度**: 中

---

### 【用例 E-010】并发购买同一用户

- **前置条件**: 用户在两个标签页同时发起购买
- **操作步骤**: 两个标签页几乎同时完成支付
- **期望后端结果**:
  - `subscriptions` 表仅 1 条记录（UNIQUE 约束）
  - 第二次 webhook 幂等处理
  - 不产生重复扣款
- **严重程度**: 致命

---

## D. 可观测性检查清单

### 必须记录的日志事件

| 事件 | 级别 | 必含字段 | 验证点 |
|------|------|----------|--------|
| `checkout.session.created` | INFO | user_id, session_id, plan | Stripe Checkout 创建成功 |
| `webhook.received` | INFO | event_id, event_type, timestamp | Webhook 到达 |
| `webhook.processed` | INFO | event_id, processing_time_ms | 处理完成 |
| `subscription.created` | INFO | user_id, tier, plan, stripe_subscription_id | 订阅创建 |
| `subscription.updated` | INFO | user_id, old_status, new_status | 状态变更 |
| `subscription.canceled` | WARN | user_id, reason, cancel_at | 取消订阅 |
| `payment.succeeded` | INFO | user_id, amount, currency, invoice_id | 支付成功 |
| `payment.failed` | ERROR | user_id, error_code, error_message | 支付失败 |
| `permission.denied` | WARN | user_id, feature_id, current_tier | 权限拒绝 |
| `quota.exceeded` | WARN | user_id, feature_id, current_usage, limit | 配额超限 |

### 必须监控的指标

| 指标 | 阈值 | 告警 |
|------|------|------|
| Webhook 处理延迟 | P95 < 5s | > 10s 告警 |
| Webhook 失败率 | < 0.1% | > 1% 告警 |
| 订阅创建成功率 | > 99% | < 95% 告警 |
| 权限校验延迟 | P95 < 100ms | > 500ms 告警 |
| 数据库同步延迟 | < 1s | > 5s 告警 |

### 审计要求

每笔交易必须可追溯:
1. Stripe Dashboard → `payment_intent_id`
2. `payment_history` 表 → `stripe_payment_intent_id`
3. `subscriptions` 表 → `stripe_subscription_id`
4. 应用日志 → `user_id + event_id`

---

## 附录: Stripe 测试卡号

| 场景 | 卡号 | CVC | 日期 |
|------|------|-----|------|
| 成功支付 | 4242424242424242 | 任意 | 任意未来 |
| 卡片被拒 | 4000000000000002 | 任意 | 任意未来 |
| 余额不足 | 4000000000009995 | 任意 | 任意未来 |
| 3DS 验证 | 4000002500003155 | 任意 | 任意未来 |
| 卡片过期 | 4000000000000069 | 任意 | 任意未来 |

---

## 更新日志

- 2026-01-21: 初始版本，包含 10 个端到端用例，10 个边界用例，权限矩阵，可观测性清单
