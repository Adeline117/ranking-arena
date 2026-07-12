# Stripe 切生产(test→live)清单 — 待 owner 执行

> 走查发现(U5-1/U5-3,2026-07-04):生产 Stripe 现跑在 **test 沙盒**
> (`STRIPE_SECRET_KEY` 是 `sk_test_`、结账会话 `cs_test_`),**真实用户从未能付款**;
> 创始会员「$49.99 终身」CTA 稳定 500,根因是**缺 `STRIPE_PRO_LIFETIME_PRICE_ID` env**
> (`app/api/stripe/create-checkout/route.ts:135` 的报错明示)。
>
> **切换全部由环境变量驱动,无需改任何代码**(create-checkout 读 `STRIPE_PRICE_IDS`
> map,map 读上述 env)。owner 一次性配 env + 翻 promo 开关即可。**代码侧已就绪。**

## 前提:先定收费时机

当前 `PRO_FREE_PROMO = true`(`lib/types/premium.ts`)全站限免。切了 live 也**没人付费**,
因为付费墙被 promo 短路。所以真正要 owner 定的是**promo 结束日**——那天一次性:
配 live env + 建 live price + 翻 `PRO_FREE_PROMO=false`。切 live 与关 promo 应同时做。

## ⚠️ 切 live 前必做:清理生产库 test 数据(2026-07-11 审计新增)

test 沙盒期在生产 `subscriptions`/`user_profiles`/`stripe_customers` 里留了
**残留 test 客户/订阅行**,切 live 后会连环爆(实查 2026-07-11):

- 2 条 `status='active'` test 订阅(`sub_1StiFLCL…` user `ebe2c2fb…`、
  `sub_1SujcrCL…` user `ae6b996d…`),带 test `cus_`,`current_period_end` 到 2027。
- 危害:① 关 promo 后这些账号白嫖 Pro 到 2027;② `create-checkout` 查到
  active 行直接 409 `ALREADY_SUBSCRIBED` → 他们**想付费也付不了**;③ 切 live 换
  webhook secret 后,这些 test 订阅的 `subscription.deleted` 事件签名校验失败,
  取消永远到不了;④ portal 用 test `cus_` 建会话 → live key 下 "No such customer" 500。

**切 live 当天,配 env 之前,先跑一次清理 SQL**(owner 或让我代跑):

```sql
-- 降级残留 test 订阅用户 + 清 test 客户 id(让 portal 走 /pricing 兜底)
UPDATE public.user_profiles
   SET subscription_tier='free', pro_plan=NULL, stripe_customer_id=NULL, updated_at=now()
 WHERE id IN ('ebe2c2fb-fba8-4fef-b88c-0248a810a57c','ae6b996d-0aed-4f57-8b40-0c738ddd1491');
DELETE FROM public.subscriptions
 WHERE stripe_subscription_id IN ('sub_1StiFLCL6ewruupgYk5CClnO','sub_1SujcrCL6ewruupgUexNTCIO');
```

先 `SELECT` 确认这两个 user 不是你要保留的真实付费者(promo 期间无人真付费,应可安全清)。
清理后再跑 `create-checkout` 三档验证。

## 一次性操作步骤(owner)

1. **Stripe 后台切 Live mode**,建/确认三档 product+price,记下各自 `price_live_...`:
   - 月付 Pro、年付 Pro、**创始会员终身 $49.99**(前 200 名逻辑代码已有,只缺 price)。
   - (若启用 elite / api 档,同样建 live price。)
2. **拿 live 密钥**:`sk_live_...`(Secret key)、`pk_live_...`(Publishable)。
3. **建 live webhook**:Stripe → Developers → Webhooks → 新端点指向
   `https://www.arenafi.org/api/stripe/webhook`,订阅 `checkout.session.completed`、`charge.dispute.created`、
   `customer.subscription.*`、`invoice.*`、`charge.refunded` 等;记下 `whsec_...`(live)。
4. **设 Vercel 生产环境变量**(Project Settings → Environment Variables → Production):
   | 变量 | 值 | 作用 |
   |---|---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` | 真实收款(替换现 sk*test*) |
   | `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` | 前端 |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...`(live) | webhook 校验 |
   | `STRIPE_PRO_MONTHLY_PRICE_ID` | `price_live_...` | 月付 |
   | `STRIPE_PRO_YEARLY_PRICE_ID` | `price_live_...` | 年付 |
   | **`STRIPE_PRO_LIFETIME_PRICE_ID`** | `price_live_...` | **修创始会员 CTA 500** |
5. **翻 promo 开关**:`lib/types/premium.ts` 的 `PRO_FREE_PROMO=false`(一处改动,恢复
   全站付费墙 + 付费诱导文案;#6 的诚实文案会自动切回付费口径)。这是代码改动,走正常 commit。
6. **部署 + 验证**:Vercel 重部署使 env 生效 → 用真卡小额或 Stripe test-clock 走通一次
   checkout(月付+终身各一)、确认 webhook 回调入账、`/pricing/success` 显示真实订单。

## 注意

- **stripe SDK 冻在 ^22.1.x**(见 memory `stripe-apiversion-deferred-2026-07-03`):
  升 22.2+ 会强改支付 API version,是独立迁移,**切 live 不需要升 SDK**,别顺手升。
- 切 live 后 test 沙盒数据(假订单/创始会员计数)与 live 分离,"0/200 创始名额"会从 live 真实计数重新开始。
- `idempotencyKey` 已在 create-checkout 就位(payment safety 铁律),重复点击不会重复扣款。

## 现状核实(2026-07-04)

本地 `.env.local` 有:STRIPE*SECRET_KEY(sk_test*)、STRIPE_PRO_MONTHLY/YEARLY_PRICE_ID、
STRIPE_WEBHOOK_SECRET、STRIPE_PUBLISHABLE_KEY — **缺 STRIPE_PRO_LIFETIME_PRICE_ID**
(=创始 CTA 500 根因)。生产 Vercel env 需 owner 核对补齐上表全部。
