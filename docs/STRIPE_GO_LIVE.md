# Stripe 2C 收费上线 Runbook

最后核验：2026-07-14。

## 当前结论

ArenaFi 的 B2C Pro 支付代码和测试沙盒已具备上线前验证条件，但**尚未开始真实收费**：

- Vercel Production 仍使用 Stripe test key，免费 promo 仍开启。
- 测试价格已与产品唯一口径一致：月付 `$4.99`、年付 `$29.99`、终身 `$49.99`。
- 测试 webhook 已启用在 `https://www.arenafi.org/api/stripe/webhook`，事件集合与代码契约一致。
- 月付、年付、终身价格 ID 以及 webhook secret 已配置到 Vercel Production、Preview、Development。
- Checkout 会在创建 Customer/Session 前验证 Price、Product、币种、金额、周期和 test/live mode；未知 Price 不授予 Pro。
- webhook 使用可重试状态机；业务处理失败不会再被误记为“已处理”。终身会员写入和订阅/profile 写入均走原子 RPC。
- 每日 `stripe-readiness` 金丝雀检查三档 B2C 价格、密钥模式、webhook 事件契约，以及失败或卡住的 webhook 事件。

因此当前状态是 **sandbox ready / paid launch not ready**。最后一步需要 owner 明确收费日期并提供 Stripe live 资源；不能把 test Price、test webhook secret 或 test Customer 直接搬到 live mode。

## 不能由代码自动决定的 owner gate

上线真实收费会改变用户价格与产生真实扣款。执行前必须明确：

1. 免费 promo 的结束时间。
2. Stripe 账户已完成收款、税务/主体、结算账户和争议通知配置。
3. 月付 `$4.99`、年付 `$29.99`、终身 `$49.99` 是最终对外价格。
4. 是否保留生产库里的两个历史 test-mode Pro 账号；默认应清理，但必须先确认不是需要保留的 QA/内部权益。

## 上线前硬门槛

以下任一项不满足都不得关闭 promo：

- Production 使用同一 mode 的 `sk_live_...` 与 `pk_live_...`。
- Live mode 中存在且启用三档 B2C Product/Price，金额和周期精确匹配产品口径。
- Live webhook 指向 canonical `www` URL，并订阅以下精确事件：
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `customer.subscription.created|updated|deleted|trial_will_end`
  - `invoice.paid|payment_succeeded|payment_failed`
  - `charge.refunded|refund.updated|charge.refund.updated`
  - `charge.dispute.created`
- Production `STRIPE_WEBHOOK_SECRET` 是这个 live endpoint 新生成的签名密钥。
- `stripe_events` 没有 `failed`，也没有超过 10 分钟的 `processing`。
- 最新部署 SHA 与 `main` 一致，部署门禁、类型检查、相关支付测试均通过。
- `/api/cron/stripe-readiness` 返回 `healthy=true`；关闭 promo 后必须进一步返回 `paidLaunchReady=true`。

## 生产库 test 数据清理

历史审计发现两条 test-mode 活跃订阅。切换 live key 后，这些 `sub_`/`cus_` 在 live mode 不存在；若不清理，会造成错误 Pro、Checkout 409 或 Portal 500。

先只读确认：

```sql
SELECT s.user_id, s.stripe_subscription_id, s.stripe_customer_id, s.status,
       p.subscription_tier, p.pro_plan
  FROM public.subscriptions s
  JOIN public.user_profiles p ON p.id = s.user_id
 WHERE s.stripe_subscription_id IN (
   'sub_1StiFLCL6ewruupgYk5CClnO',
   'sub_1SujcrCL6ewruupgUexNTCIO'
 );
```

owner 确认后，在同一事务中清理：

```sql
BEGIN;

UPDATE public.user_profiles
   SET subscription_tier = 'free',
       pro_plan = NULL,
       stripe_customer_id = NULL,
       updated_at = now()
 WHERE id IN (
   'ebe2c2fb-fba8-4fef-b88c-0248a810a57c',
   'ae6b996d-0aed-4f57-8b40-0c738ddd1491'
 );

DELETE FROM public.subscriptions
 WHERE stripe_subscription_id IN (
   'sub_1StiFLCL6ewruupgYk5CClnO',
   'sub_1SujcrCL6ewruupgUexNTCIO'
 );

COMMIT;
```

清理后立即回读上述查询，结果必须为 0 行。

## Live 切换实施顺序

1. 在 Stripe Dashboard 切到 Live mode，创建/确认 B2C Pro 三档价格。
2. 创建 live webhook endpoint，使用上面的精确事件集合；保存新 `whsec_...`。
3. 在 Vercel Production 更新：

   | 变量                                 | Live 值                      |
   | ------------------------------------ | ---------------------------- |
   | `STRIPE_SECRET_KEY`                  | `sk_live_...`                |
   | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_...`                |
   | `STRIPE_WEBHOOK_SECRET`              | live endpoint 的 `whsec_...` |
   | `STRIPE_PRO_MONTHLY_PRICE_ID`        | 月付 live Price              |
   | `STRIPE_PRO_YEARLY_PRICE_ID`         | 年付 live Price              |
   | `STRIPE_PRO_LIFETIME_PRICE_ID`       | 终身 live Price              |

4. 保持 `NEXT_PUBLIC_PRO_FREE_PROMO` 开启，先重新部署；不要在同一步开始收费。
5. 用 Cron secret 调用 `/api/cron/stripe-readiness`，确认除 promo owner gate 外无失败。
6. 用内部真实账号分别创建月付、年付、终身 Checkout Session，核对 Stripe 托管页金额、币种和 mode；此时不要完成不必要的真实付款。
7. 将 `NEXT_PUBLIC_PRO_FREE_PROMO=false`，再次部署。
8. 立即确认 `stripe-readiness` 返回 `healthy=true`、`paidLaunchReady=true`。
9. 用允许退款的小额真实卡交易完成月付和终身各一次，逐项回读：
   - Stripe Payment/Subscription 状态正确；
   - `stripe_events.status='processed'`；
   - `subscriptions`、`user_profiles` 权益一致；
   - `/pricing/success` 与会员中心显示正确；
   - Portal 可打开；取消、退款、争议测试能撤权且不会影响更新的订阅。
10. 在 Stripe 完成退款，并确认退款 webhook 与本地撤权闭环。

## 发布后 24 小时验收

- 每 30 分钟检查支付错误率、Checkout 5xx、webhook `failed/processing`。
- 对每一笔真实订单核对 Stripe 与本地权益，不以 UI 成功页作为付款证据。
- 检查重复 webhook、乱序取消事件不会重复授予或撤销新订阅。
- 检查 `reconcile-subscriptions` 与 `subscription-expiry`：Stripe 故障时必须保留权限并告警，不能误升级或误降级。
- 记录首日 `checkout_started → checkout_completed → pro_activated` 漏斗，和取消/退款原因。

## 安全回滚

若付费墙或 Checkout 出现严重故障：

1. 立即把 `NEXT_PUBLIC_PRO_FREE_PROMO` 恢复为开启并重新部署，使用户继续可用。
2. **不要切回 test key，也不要删除 live webhook**；已有真实订阅的续费、取消、退款事件仍必须继续处理。
3. 停止新的付费入口后修复问题，保持 `stripe-readiness` 和 webhook 告警运行。
4. 对受影响订单从 Stripe 逐笔核对并退款，禁止直接根据本地表猜测付款状态。

这套回滚只关闭新付费墙，不破坏已经产生的真实财务事件。
