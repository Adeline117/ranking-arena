# Stripe 2C 收费上线 Runbook

最后核验：2026-07-18。

## 当前结论

ArenaFi 的 B2C Pro **尚未开始真实收费，当前支付入口必须保持关闭**：

- Vercel Production 仍使用 Stripe test key，免费 promo 仍开启。
- Production 缺少 `STRIPE_WEBHOOK_SECRET`；支付运行时门禁会拒绝创建 B2C、API 和付费群 Checkout，不能把这个 fail-closed 状态称为 sandbox ready。
- `NEXT_PUBLIC_PRO_FREE_PROMO` 未显式配置，代码当前按免费 promo 开启处理。
- `STRIPE_LIFETIME_CHECKOUT_ENABLED` 未配置；终身 Checkout 默认关闭，只有完成名额 reservation、退款和 readiness 验收后才能显式开启。
- 测试价格已与产品唯一口径一致：月付 `$4.99`、年付 `$29.99`、终身 `$49.99`。
- Checkout 会在创建 Customer/Session 前验证 Price、Product、币种、金额、周期和 test/live mode；未知 Price 不授予 Pro。
- webhook 使用可重试状态机；业务处理失败不会再被误记为“已处理”。`20260718183000` entitlement authority 与 `20260718183500` NULL fail-closed 加固已经作为 PREDEPLOY 落库，但最终撤销旧 RPC、封禁 direct DML 的 Stripe POSTDEPLOY 尚未在仓库中实现或分配迁移版本，仍是付费上线硬阻断。当前 `20260718184000` 是榜单 `board_as_of` 水位迁移，与 Stripe 切换无关。
- 每日 `stripe-readiness` 金丝雀检查三档 B2C 价格、密钥模式、webhook 事件契约、失败或卡住的 webhook 事件，以及数据库权威函数 `stripe_paid_launch_readiness_v2()` 的精确九键契约。九键必须包含 `unresolved_refund_tombstones`，任何未合并的 Charge 退款墓碑都必须阻断付费开放。

因此当前状态是 **paid launch blocked by design**。不能把 test Price、test Customer 或其他 Stripe account/mode 的对象直接搬到 live mode，也不能仅补一个环境变量就开始收费。

## 不能由代码自动决定的 owner gate

上线真实收费会改变用户价格与产生真实扣款。执行前必须明确：

1. 免费 promo 的结束时间。
2. Stripe 账户已完成收款、税务/主体、结算账户和争议通知配置。
3. 月付 `$4.99`、年付 `$29.99`、终身 `$49.99` 是最终对外价格。
4. 如何处理生产库里的两个历史模糊 Pro 投影。它们不能被证明属于 test/live、真实付款或内部赠送；默认动作是保留并阻断切换，而不是自动清理。

## 上线前硬门槛

以下任一项不满足都不得关闭 promo：

- Production 使用同一 mode 的 `sk_live_...` 与 `pk_live_...`。
- Live mode 中存在且启用三档 B2C Product/Price，金额和周期精确匹配产品口径。
- Live webhook 指向 canonical `www` URL，并订阅以下精确事件：
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `customer.subscription.created|updated|deleted|trial_will_end`
  - `invoice.paid|payment_succeeded|payment_failed|payment_action_required|finalization_failed`
  - `charge.refunded|refund.updated|charge.refund.updated`
  - `charge.dispute.created`
- Production `STRIPE_WEBHOOK_SECRET` 是这个 live endpoint 新生成的签名密钥。
- `STRIPE_LIFETIME_CHECKOUT_ENABLED` 只能在终身名额 reservation、Session 过期释放、退款回收和 200 席并发 canary 全部通过后设为精确值 `true`。
- `stripe_events` 没有 `failed`，也没有超过 10 分钟的 `processing`。
- 最新部署 SHA 与 `main` 一致，部署门禁、类型检查、相关支付测试均通过。
- `/api/cron/stripe-readiness` 返回 `healthy=true`，且 `entitlementReadiness.status=ready`、八个计数全部为 `0`；关闭 promo 后必须进一步返回 `paidLaunchReady=true`。缺键、额外键、负数、非整数或 `unresolved_refund_tombstones>0` 一律 fail closed。

## 历史订阅隔离与证据门

生产库有两条 `active/pro` 订阅投影缺少 `plan`，且 profile、订阅和支付历史无法组成完整付款权威。仓库历史可以解释这种形状：旧初始化先创建本地订阅行，旧 webhook 后来写入 Customer、Subscription、状态和周期，却没有写 `plan` 或后续新增的 profile 字段。

这只能证明它们是历史遗留投影，**不能证明它们属于 Stripe test mode、live mode、哪个 account/sandbox，也不能证明是否真实扣款**。`sub_`/`cus_` 前缀不携带 mode；当前 key 返回 `resource_missing` 也可能表示另一 mode、另一 account、旧 sandbox 或已不可用对象。

先用只读查询识别异常形状，不在查询或文档中硬编码用户和 Stripe 对象：

```sql
SELECT s.id, s.user_id, s.stripe_subscription_id, s.stripe_customer_id,
       s.status, s.tier, s.plan, s.current_period_start, s.current_period_end,
       p.subscription_tier, p.pro_plan, p.pro_expires_at, p.is_pro,
       p.stripe_customer_id AS profile_stripe_customer_id,
       p.stripe_subscription_id AS profile_stripe_subscription_id
  FROM public.subscriptions s
  JOIN public.user_profiles p ON p.id = s.user_id
 WHERE s.status IN ('active', 'trialing')
   AND s.tier = 'pro'
   AND (s.stripe_customer_id IS NOT NULL
        OR s.stripe_subscription_id IS NOT NULL)
   AND (s.plan IS NULL
        OR (s.plan IN ('monthly', 'yearly')
            AND (s.current_period_start IS NULL
                 OR s.current_period_end IS NULL)));
```

必须先保存不可变证据和 owner 决策，再选择以下唯一允许的结果：

1. **已证实为 sandbox/QA 且 owner 决定不保留权益**：通过受审计的事务性 lifecycle 路径退役本地投影，并清理全部六个 Pro/Stripe profile 投影字段；不要 `DELETE` 丢失审计历史。
2. **已证实为 live 真实付款或有效 trial**：从准确 Stripe account/mode 的 Subscription、Invoice、Charge/PaymentIntent、Price 和 period 重建 exact payment/trial authority；禁止根据周期长度猜 `plan`。
3. **owner 明确认定为内部赠送并决定保留**：先退役伪 Stripe 投影，再通过专门的、有限期限且带 decision/ticket key 的 internal-comp grant RPC 授予；不得冒充 `referral`、不得 direct insert、不得伪造付款。
4. **证据仍不足或 owner 未决定**：保持投影不变并维持 manual review；允许 additive PREDEPLOY 只做隔离，但禁止 POSTDEPLOY 权威切换和真实收费。

无论选择哪种结果，都禁止手填 `plan`、伪造 `payment_history`/付款 ledger、根据开发者角色或显示名自动清理、用当前错误 mode/account 的 key 远端取消对象。manual review 只有在对应权威或退役结果已由同一事务精确落库并回读后才能解决。

## Live 切换实施顺序

1. 保持免费 promo 开启、支付运行时门禁关闭、`STRIPE_LIFETIME_CHECKOUT_ENABLED` 不存在或不为 `true`；停止制造新的历史形状。
2. 对历史模糊投影执行上一节的证据门。未解决项必须保持 open manual review，后续 readiness 和 POSTDEPLOY 应明确失败。
3. 核对 additive `20260718183000` PREDEPLOY 与 `20260718183500` NULL hardening 在迁移 ledger 中均为 exact。不得把榜单水位迁移 `20260718184000` 当作 Stripe POSTDEPLOY。
4. 部署所有身份完整 writer：Customer owner CAS、Checkout reservation、invoice/subscription/refund RPC、group/referral/admin/account lifecycle、effect consumer 和 projection reconciler。退款必须先按 Charge 查询本地 immutable ledger；owner 已删除或 refund-first 时也不能提前 ACK 丢事件。
5. 分页枚举并过期/对账所有旧 lifetime open Session；确认旧实例和旧 writer 已从流量中退出。
6. 运行 writer-boundary 静态扫描、真实 canary 和 readiness。任何 open review、未完成 effect、paid-but-unbound payment、未合并 refund tombstone、reservation/projection/authority drift 都必须阻断。
7. 只有 readiness 精确为 ready、同一待发布 SHA 的 canary 全绿，并且真正的 Stripe POSTDEPLOY 已另行实现、分配新版本、完成 PostgreSQL 17 对抗测试且注册到受审 runner 后，才可单独应用它来撤销旧 RPC 并启用数据库 direct-DML guard。当前仓库不具备这一步，因此 paid launch 必须保持 blocked；此后也不能靠回滚旧 app 恢复。
8. 在 Stripe Dashboard 切到 Live mode，创建/确认 B2C Pro 三档价格。
9. 创建 live webhook endpoint，使用上面的精确事件集合；保存新 `whsec_...`。
10. 在 Vercel Production 更新：

| 变量                                 | Live 值                      |
| ------------------------------------ | ---------------------------- |
| `STRIPE_SECRET_KEY`                  | `sk_live_...`                |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_...`                |
| `STRIPE_WEBHOOK_SECRET`              | live endpoint 的 `whsec_...` |
| `STRIPE_PRO_MONTHLY_PRICE_ID`        | 月付 live Price              |
| `STRIPE_PRO_YEARLY_PRICE_ID`         | 年付 live Price              |
| `STRIPE_PRO_LIFETIME_PRICE_ID`       | 终身 live Price              |

11. 保持 `NEXT_PUBLIC_PRO_FREE_PROMO` 开启并重新部署；不要在同一步开始收费，终身 flag 仍保持关闭。
12. 用 Cron secret 调用 `/api/cron/stripe-readiness`，确认除 promo owner gate 外无失败。
13. 用受保护 Preview 或内部 allowlist 验证月付、年付和终身托管页的金额、币种和 mode；终身流程还必须证明 reservation 占位与 Session 过期释放。
14. 先只开放月付/年付并重新部署；立即确认 `stripe-readiness` 返回 `healthy=true`、`paidLaunchReady=true`。终身 Checkout 在独立 200 席并发/退款 canary 通过前继续关闭。
15. 用允许退款的小额真实卡交易完成月付一次，逐项回读：

- Stripe Payment/Subscription 状态正确；
- `stripe_events.status='processed'`；
- `subscriptions`、`user_profiles` 权益一致；
- `/pricing/success` 与会员中心显示正确；
- Portal 可打开；取消、退款、争议测试能撤权且不会影响更新的订阅。

16. 在 Stripe 完成退款，并确认退款 webhook、本地撤权、outbox supersede、官方群退出和 projection 收敛闭环。
17. 单独完成终身真实 canary后，才把 `STRIPE_LIFETIME_CHECKOUT_ENABLED=true` 并重新部署；再次验证席位从 reservation 到付款或过期的完整生命周期。

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
