# 付费链路 QA 测试用例文档

> 版本: 1.1.0
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

## A. 端到端核心用例

### 【用例001】未登录用户完整购买流程
- **前置条件**：用户未登录，无账号
- **操作步骤**：
  1. 访问首页 → 点击Pro功能（如排行榜高级筛选）
  2. 触发 `PremiumGate` 组件 → 点击"升级Pro"
  3. 弹出登录弹窗 → 选择注册
  4. 完成注册 → 自动跳转 checkout 页面
  5. 完成 Stripe 支付
  6. 等待 webhook 处理 → 跳转 success 页面
- **期望UI结果**：
  - 显示"订阅成功"提示
  - 导航栏出现 Pro 徽章
  - 原 PremiumGate 内容解锁可见
- **期望后端结果**：
  - `subscriptions` 表新增记录：tier='pro', status='active'
  - `user_profiles.subscription_tier` = 'pro'
  - `pro_official_group_members` 表新增记录（自动入群）
- **期望权限结果**：
  - `checkFeatureAccess('trader_alerts')` 返回 `hasAccess: true`
  - 历史数据从7天扩展到90天
- **失败时应提示**：支付失败时显示具体原因，不显示空白页
- **严重程度**：致命

---

### 【用例002】已登录Free用户升级Pro（月付）
- **前置条件**：用户已登录，tier='free'
- **操作步骤**：
  1. 点击设置页 → 订阅管理 → "升级到Pro"
  2. 选择月付方案 $9.99/月
  3. 跳转 Stripe Checkout → 使用测试卡 `4242424242424242` 完成支付
  4. Webhook 触发 `checkout.session.completed`
- **期望UI结果**：
  - `/settings?success=true` 页面显示成功
  - 刷新后 `PremiumBadge` 显示 "Pro"
- **期望后端结果**：
  - `subscriptions.tier` 从 'free' 更新为 'pro'
  - `subscriptions.stripe_subscription_id` 有值
  - `subscriptions.plan` = 'monthly'
  - `current_period_end` 正确设置
  - `payment_history` 记录 `status='succeeded', amount=999`
- **期望权限结果**：`useIsPremium()` 返回 true
- **失败时应提示**：若支付取消，跳转 `/settings?canceled=true`
- **严重程度**：致命

---

### 【用例003】已登录Free用户升级Pro（年付）
- **前置条件**：用户已登录，tier='free'
- **操作步骤**：
  1. 点击"升级 Pro"
  2. 选择"年付 $99.99（省 17%）"
  3. 完成 Stripe 支付
- **期望后端结果**：
  - `subscriptions.plan = 'yearly'`
  - `current_period_end` 为一年后
  - `payment_history.amount = 9999`
- **严重程度**：致命

---

### 【用例004】Pro用户续费成功
- **前置条件**：用户tier='pro'，订阅即将到期（7天内）
- **操作步骤**：
  1. Stripe 自动扣款成功
  2. Webhook 接收 `invoice.payment_succeeded`
- **期望UI结果**：无中断，功能持续可用
- **期望后端结果**：
  - `subscriptions.current_period_end` 延长一个周期
  - `subscriptions.status` 保持 'active'
  - `payment_history` 新增成功记录
- **期望权限结果**：权限无变化
- **失败时应提示**：N/A（后台处理）
- **严重程度**：致命

---

### 【用例005】Pro用户主动取消订阅
- **前置条件**：用户tier='pro', status='active'
- **操作步骤**：
  1. 设置页 → 订阅管理 → "取消订阅"
  2. 确认取消弹窗 → 确认
  3. 调用 `cancelSubscription()` API
- **期望UI结果**：
  - 显示"订阅已取消，将在 {date} 到期后降级"
  - 功能仍可用直到 `current_period_end`
- **期望后端结果**：
  - Stripe: `subscription.cancel_at_period_end = true`
  - 本地: `subscriptions.status` 保持 'active'（暂不改变）
- **期望权限结果**：到期前权限不变
- **失败时应提示**：取消失败时显示具体错误
- **严重程度**：高

---

### 【用例006】取消后到期降级
- **前置条件**：用户已取消，`current_period_end` 已过
- **操作步骤**：
  1. Stripe 发送 `customer.subscription.deleted` webhook
- **期望UI结果**：
  - 下次登录显示"您的Pro已到期"提示
  - `PremiumBadge` 变回 "Free"
  - Pro功能被 `PremiumGate` 遮挡
- **期望后端结果**：
  - `subscriptions.tier` = 'free'
  - `subscriptions.status` = 'cancelled'
  - `pro_official_group_members` 移除该用户
- **期望权限结果**：
  - `useIsPremium()` 返回 false
  - `checkFeatureAccess('trader_alerts')` 返回 `hasAccess: false`
- **失败时应提示**：N/A
- **严重程度**：致命

---

### 【用例007】续费失败（卡过期/余额不足）
- **前置条件**：用户tier='pro'，卡信息失效
- **操作步骤**：
  1. Stripe 扣款失败
  2. Webhook 接收 `invoice.payment_failed`
- **期望UI结果**：
  - 显示"支付失败，请更新付款方式"通知
  - 引导跳转 Stripe Customer Portal
- **期望后端结果**：
  - `subscriptions.status` = 'past_due'
  - `payment_history` 记录 `status='failed'`
- **期望权限结果**：
  - 宽限期内(3天)权限暂不变
  - 宽限期后降级为 free
- **失败时应提示**：邮件通知 + 应用内提示
- **严重程度**：致命

---

### 【用例008】已取消用户重新订阅
- **前置条件**：`subscriptions.status = 'canceled'`
- **操作步骤**：
  1. 点击"重新订阅"
  2. 完成 Stripe 支付
- **期望后端结果**：
  - `subscriptions.status = 'active'`
  - 新的 `current_period_start/end`
  - `user_profiles.subscription_tier = 'pro'`
- **严重程度**：高

---

### 【用例009】Pro用户访问受限功能 - Trader Comparison
- **前置条件**：`user_profiles.subscription_tier = 'pro'`
- **操作步骤**：
  1. 访问交易员对比页面
  2. 选择 2 个交易员进行对比
  3. 点击"生成对比报告"
- **期望 UI 结果**：正常显示对比图表和数据
- **期望后端结果**：
  - `/api/compare` 返回 200
  - 该用户本月 `comparisonReportsThisMonth` +1
- **期望权限结果**：功能正常使用（10次/月限制）
- **严重程度**：高

---

### 【用例010】Free用户访问Pro功能 - Advanced Filter
- **前置条件**：`user_profiles.subscription_tier = 'free'`
- **操作步骤**：
  1. 访问排行榜页面
  2. 点击"高级筛选"按钮
- **期望 UI 结果**：
  - 显示 Paywall 遮罩
  - 显示"升级 Pro 解锁多条件筛选"
  - 显示价格和升级按钮
- **期望后端结果**：不触发筛选 API
- **期望权限结果**：功能不可用
- **失败时应提示**：无（直接显示 Paywall）
- **严重程度**：高

---

## B. 权限矩阵

| 功能 | Free 可见 | Free 可用 | Pro 可见 | Pro 可用 | 验证点 |
|------|-----------|-----------|----------|----------|--------|
| 排行榜浏览 | ✅ | ✅ | ✅ | ✅ | 首页可访问 |
| 基础筛选（交易所） | ✅ | ✅ | ✅ | ✅ | 下拉菜单可用 |
| **高级筛选（多条件）** | ✅ | ❌ Paywall | ✅ | ✅ | `advanced_filter` feature check |
| 交易员详情页 | ✅ | ✅ | ✅ | ✅ | `/trader/[handle]` 可访问 |
| **Arena Score 详情** | ✅ | ❌ 模糊 | ✅ | ✅ | `score_breakdown` feature check |
| **交易员对比** | ✅ | ❌ Paywall | ✅ | ✅ (10次/月) | `trader_comparison` feature check |
| 历史数据 | ✅ | ✅ (7天) | ✅ | ✅ (90天) | `historical_data` feature check |
| 关注交易员 | ✅ | ✅ (10人) | ✅ | ✅ (50人) | `useFollowLimit()` hook |
| 发帖 | ✅ | ✅ (3条/天) | ✅ | ✅ (无限) | API 层检查 |
| **交易员预警** | ❌ | - | ✅ | ✅ | `trader_alerts` feature check |
| **Pro官方群** | ❌ | - | ✅ | ✅ | `premium_groups` feature check |
| **数据导出** | ✅ | ❌ | ✅ | ✅ (10次/月) | `export_data` feature check |
| **API访问** | ❌ | - | ✅ | ✅ (1000次/天) | `api_access` feature check |
| Pro徽章 | ❌ | - | ✅ | ✅ | `pro_badge` feature check |
| 分类排行 | ✅ | ❌ | ✅ | ✅ | `category_ranking` feature check |
| 邮件通知 | ❌ | - | ✅ | ✅ | `email_notifications` feature check |
| 推送通知 | ❌ | - | ✅ | ✅ | `push_notifications` feature check |
| 自定义排行 | ❌ | - | ✅ | ✅ | `custom_rankings` feature check |
| 投资组合建议 | ❌ | - | ✅ | ✅ | `portfolio_suggestions` feature check |

**验证方法**：
```typescript
// 前端验证
const { hasAccess, remaining } = useFeatureAccess('trader_alerts')

// 后端验证 (API路由)
if (!hasFeatureAccess(tier, 'premium_groups')) {
  return NextResponse.json({ error: 'PRO_REQUIRED' }, { status: 403 })
}
```

---

## C. 反作弊/边界用例

### 【用例E-001】重复点击支付按钮
- **前置条件**：用户在 Checkout 页面
- **操作步骤**：快速连续点击"支付"按钮5次
- **期望结果**：
  - 按钮点击后立即 disabled + loading
  - 只创建1个 Stripe session
  - 不产生重复订阅
- **验证**：检查 Stripe Dashboard 只有1条记录
- **严重程度**：致命

---

### 【用例E-002】支付过程中网络中断
- **前置条件**：用户在 Stripe 输入卡号后
- **操作步骤**：点击支付后立即断开网络
- **期望 UI 结果**：恢复网络后显示明确状态（成功/失败）
- **期望后端结果**：通过 `/api/stripe/verify-session` 同步最终状态
- **严重程度**：高

---

### 【用例E-003】Webhook 延迟（支付成功但webhook未到）
- **前置条件**：用户完成支付，但 webhook 延迟 5 分钟
- **操作步骤**：
  1. 支付成功 → 跳转 success 页面
  2. 用户立即刷新/访问Pro功能
- **期望结果**：
  - 前端调用 `useSubscription().refresh()` 轮询
  - 显示"正在验证订阅状态..."提示
  - 超过30秒无变化，显示"请稍后刷新"
  - verify-session 主动查询 Stripe 并更新数据库
- **验证**：不应显示"购买失败"
- **严重程度**：高

---

### 【用例E-004】Webhook 重复投递
- **前置条件**：同一 event 被 Stripe 投递 2 次
- **操作步骤**：接收重复的 `checkout.session.completed`
- **期望后端结果**：
  - 第一次正常处理
  - 第二次幂等跳过（通过 event_id 检查）
  - `subscriptions` 表仅 1 条记录
- **严重程度**：高

---

### 【用例E-005】同一账号多设备登录
- **前置条件**：用户在设备A已登录Pro
- **操作步骤**：
  1. 在设备B登录同一账号
  2. 设备A取消订阅
  3. 设备B刷新页面
- **期望结果**：
  - 设备B权限同步更新
  - 权限通过 API 实时验证，不依赖本地缓存
  - 缓存（5分钟）过期后自动刷新状态
- **验证**：Supabase auth 状态一致
- **严重程度**：高

---

### 【用例E-006】伪造 tier 前端绕过
- **前置条件**：Free用户修改前端状态
- **操作步骤**：
  1. 修改 localStorage 中的 tier 为 'pro'
  2. 访问 Pro API
- **期望结果**：
  - API 返回 403
  - RLS 策略阻止数据访问
- **验证**：后端必须从数据库验证 tier
- **严重程度**：致命（安全）

---

### 【用例E-007】Stripe Webhook 签名验证失败
- **前置条件**：伪造 webhook 请求
- **操作步骤**：发送无效签名的 webhook
- **期望结果**：
  - 返回 400 错误
  - 不更新数据库
  - 记录安全日志
- **验证**：`constructWebhookEvent()` 抛出异常
- **严重程度**：致命（安全）

---

### 【用例E-008】退款后权限回收
- **前置条件**：用户Pro订阅，Stripe发起退款
- **操作步骤**：
  1. Stripe Dashboard 发起全额退款
  2. Webhook 接收 `charge.refunded`
- **期望结果**：
  - `subscriptions.status` = 'cancelled'
  - `tier` 降为 'free'
  - 立即移除 Pro 权限
  - `payment_history` 记录 `status='refunded'`
- **严重程度**：高

---

### 【用例E-009】价格变更后老用户续费
- **前置条件**：用户以 $9.99/月 订阅，新价格 $14.99
- **操作步骤**：老用户续费周期到达
- **期望结果**：
  - 按原价格续费（Stripe price ID 绑定）
  - 或：提前通知价格变更
- **严重程度**：中

---

### 【用例E-010】并发创建多个 Checkout Session
- **前置条件**：恶意用户脚本并发调用
- **操作步骤**：同时发送10个 `/api/checkout` 请求
- **期望结果**：
  - 幂等性：同一用户只有1个活跃 session
  - 或：限流返回 429
  - `subscriptions` 表仅 1 条记录（UNIQUE 约束）
- **严重程度**：致命

---

### 【用例E-011】卡片验证失败（3DS 挑战失败）
- **前置条件**：用户使用需要 3DS 验证的卡
- **操作步骤**：在 3DS 弹窗中点击"取消"或验证失败
- **期望 UI 结果**：显示"支付验证失败，请重试"
- **期望后端结果**：`subscriptions` 表无新记录
- **严重程度**：中

---

### 【用例E-012】货币转换场景
- **前置条件**：用户使用非 USD 货币卡
- **操作步骤**：完成支付
- **期望后端结果**：`payment_history.currency = 'usd'`，金额正确（以美分计）
- **严重程度**：中

---

## D. 可观测性检查清单

### 必须记录的日志事件

| 事件 | 级别 | 必含字段 | 目的 |
|------|------|----------|------|
| `checkout.session.created` | INFO | user_id, session_id, plan, amount | 追踪转化漏斗 |
| `webhook.received` | INFO | event_id, event_type, timestamp | Webhook 到达 |
| `webhook.processed` | INFO | event_id, processing_time_ms | 处理完成 |
| `subscription.created` | INFO | user_id, tier, plan, stripe_subscription_id | 订阅创建 |
| `subscription.updated` | INFO | user_id, old_status, new_status | 状态变更 |
| `subscription.canceled` | WARN | user_id, reason, cancel_at | 取消订阅 |
| `payment.succeeded` | INFO | user_id, amount, currency, invoice_id | 支付成功 |
| `payment.failed` | ERROR | user_id, error_code, error_message | 支付失败/排障 |
| `permission.denied` | WARN | user_id, feature_id, current_tier | 权限拒绝/识别滥用 |
| `quota.exceeded` | WARN | user_id, feature_id, current_usage, limit | 配额超限 |
| Pro群组加入/退出 | INFO | user_id, group_id, action | 追踪自动化 |

### 必须监控的指标

| 指标 | 阈值 | 告警 |
|------|------|------|
| Webhook 处理延迟 | P95 < 5s | > 10s 告警 |
| Webhook 失败率 | < 0.1% | > 1% 告警 |
| 订阅创建成功率 | > 99% | < 95% 告警 |
| 权限校验延迟 | P95 < 100ms | > 500ms 告警 |
| 数据库同步延迟 | < 1s | > 5s 告警 |
| 新订阅数/天 | - | 监控趋势 |
| 取消率/月 | - | 监控趋势 |
| 续费成功率 | > 95% | < 90% 告警 |

### Sentry 错误监控

必须捕获的错误:
- Stripe webhook 验证失败
- 订阅状态更新失败
- 权限检查异常
- Checkout 创建失败

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

- 2026-01-21 v1.1.0: 合并两个版本的测试用例，统一编号规范
- 2026-01-21 v1.0.0: 初始版本
