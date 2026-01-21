# 付费链路QA测试用例

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

### 【用例002】已登录Free用户升级Pro
- **前置条件**：用户已登录，tier='free'
- **操作步骤**：
  1. 点击设置页 → 订阅管理 → "升级到Pro"
  2. 选择月付/年付方案
  3. 跳转 Stripe Checkout → 完成支付
  4. Webhook 触发 `checkout.session.completed`
- **期望UI结果**：
  - `/settings?success=true` 页面显示成功
  - 刷新后 `PremiumBadge` 显示 "Pro"
- **期望后端结果**：
  - `subscriptions.tier` 从 'free' 更新为 'pro'
  - `subscriptions.stripe_subscription_id` 有值
  - `current_period_end` 正确设置
- **期望权限结果**：`useIsPremium()` 返回 true
- **失败时应提示**：若支付取消，跳转 `/settings?canceled=true`
- **严重程度**：致命

---

### 【用例003】Pro用户续费成功
- **前置条件**：用户tier='pro'，订阅即将到期（7天内）
- **操作步骤**：
  1. Stripe 自动扣款成功
  2. Webhook 接收 `invoice.payment_succeeded`
- **期望UI结果**：无中断，功能持续可用
- **期望后端结果**：
  - `subscriptions.current_period_end` 延长一个周期
  - `subscriptions.status` 保持 'active'
- **期望权限结果**：权限无变化
- **失败时应提示**：N/A（后台处理）
- **严重程度**：高

---

### 【用例004】Pro用户主动取消订阅
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

### 【用例005】取消后到期降级
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
- **严重程度**：高

---

### 【用例006】续费失败（卡过期/余额不足）
- **前置条件**：用户tier='pro'，卡信息失效
- **操作步骤**：
  1. Stripe 扣款失败
  2. Webhook 接收 `invoice.payment_failed`
- **期望UI结果**：
  - 显示"支付失败，请更新付款方式"通知
  - 引导跳转 Stripe Customer Portal
- **期望后端结果**：
  - `subscriptions.status` = 'past_due'
- **期望权限结果**：
  - 宽限期内(3天)权限暂不变
  - 宽限期后降级为 free
- **失败时应提示**：邮件通知 + 应用内提示
- **严重程度**：高

---

## B. 权限矩阵

| 功能 | Free | Pro | 验证点 |
|------|------|-----|--------|
| 排行榜浏览 | ✅ | ✅ | 首页可访问 |
| 基础筛选（交易所） | ✅ | ✅ | 下拉菜单可用 |
| **高级筛选（多条件）** | ❌ | ✅ | `advanced_filter` feature check |
| 交易员详情页 | ✅ | ✅ | `/trader/[handle]` 可访问 |
| **Arena Score 详情** | ❌ | ✅ | `score_breakdown` feature check |
| **交易员对比** | ❌ | ✅ | `trader_comparison`, 10次/月 |
| 历史数据 | 7天 | 90天 | `historical_data` feature check |
| 关注交易员 | 10人 | 50人 | `useFollowLimit()` hook |
| 发帖 | 3条/天 | 无限 | API 层检查 |
| **交易员预警** | ❌ | ✅ | `trader_alerts` feature check |
| **Pro官方群** | ❌ | ✅ | `premium_groups` feature check |
| **数据导出** | ❌ | ✅ | `export_data`, 10次/月 |
| **API访问** | ❌ | ✅ | `api_access`, 1000次/天 |
| Pro徽章 | ❌ | ✅ | `pro_badge` feature check |

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

### 【用例007】重复点击支付按钮
- **前置条件**：用户在 Checkout 页面
- **操作步骤**：快速连续点击"支付"按钮5次
- **期望结果**：
  - 按钮点击后立即 disabled + loading
  - 只创建1个 Stripe session
  - 不产生重复订阅
- **验证**：检查 Stripe Dashboard 只有1条记录
- **严重程度**：高

---

### 【用例008】Webhook 延迟（支付成功但webhook未到）
- **前置条件**：用户完成支付，但 webhook 延迟 5 分钟
- **操作步骤**：
  1. 支付成功 → 跳转 success 页面
  2. 用户立即刷新/访问Pro功能
- **期望结果**：
  - 前端调用 `useSubscription().refresh()` 轮询
  - 显示"正在验证订阅状态..."提示
  - 超过30秒无变化，显示"请稍后刷新"
- **验证**：不应显示"购买失败"
- **严重程度**：高

---

### 【用例009】同一账号多设备登录
- **前置条件**：用户在设备A已登录Pro
- **操作步骤**：
  1. 在设备B登录同一账号
  2. 设备A取消订阅
  3. 设备B刷新页面
- **期望结果**：
  - 设备B权限同步更新
  - 缓存（5分钟）过期后自动刷新状态
- **验证**：Supabase auth 状态一致
- **严重程度**：中

---

### 【用例010】网络中断后恢复
- **前置条件**：用户正在支付流程中
- **操作步骤**：
  1. 断网 → 点击支付
  2. 恢复网络
- **期望结果**：
  - 显示明确的网络错误提示
  - 恢复后可重试，无重复扣款
- **严重程度**：高

---

### 【用例011】Stripe Webhook 签名验证失败
- **前置条件**：伪造 webhook 请求
- **操作步骤**：发送无效签名的 webhook
- **期望结果**：
  - 返回 400 错误
  - 不更新数据库
  - 记录安全日志
- **验证**：`constructWebhookEvent()` 抛出异常
- **严重程度**：致命（安全）

---

### 【用例012】退款后权限回收
- **前置条件**：用户Pro订阅，Stripe发起退款
- **操作步骤**：
  1. Stripe Dashboard 发起全额退款
  2. Webhook 接收 `charge.refunded`
- **期望结果**：
  - `subscriptions.status` = 'cancelled'
  - `tier` 降为 'free'
  - 立即移除 Pro 权限
- **严重程度**：高

---

### 【用例013】价格变更后老用户续费
- **前置条件**：用户以 $9.99/月 订阅，新价格 $14.99
- **操作步骤**：老用户续费周期到达
- **期望结果**：
  - 按原价格续费（Stripe price ID 绑定）
  - 或：提前通知价格变更
- **严重程度**：中

---

### 【用例014】并发创建多个 Checkout Session
- **前置条件**：恶意用户脚本并发调用
- **操作步骤**：同时发送10个 `/api/checkout` 请求
- **期望结果**：
  - 幂等性：同一用户只有1个活跃 session
  - 或：限流返回 429
- **严重程度**：中

---

### 【用例015】伪造 tier 前端绕过
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

## D. 可观测性检查清单

### 必须记录的事件

| 事件 | 日志字段 | 目的 |
|------|----------|------|
| 创建 Checkout Session | user_id, session_id, plan, amount | 追踪转化漏斗 |
| Webhook 接收 | event_type, subscription_id, timestamp | 验证处理 |
| 订阅状态变更 | user_id, old_tier, new_tier, reason | 审计 |
| 支付失败 | user_id, error_code, failure_reason | 排障 |
| 权限检查失败 | user_id, feature_id, current_tier | 识别滥用 |
| Pro群组加入/退出 | user_id, group_id, action | 追踪自动化 |

### Sentry 错误监控

```typescript
// 必须捕获的错误
- Stripe webhook 验证失败
- 订阅状态更新失败
- 权限检查异常
- Checkout 创建失败
```

### 关键指标 Dashboard

```
- 新订阅数/天
- 取消率/月
- 续费成功率
- Webhook 处理延迟 P95
- 权限检查错误率
```
