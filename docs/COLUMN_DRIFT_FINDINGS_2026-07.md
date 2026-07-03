# 列级写漂移发现 — 待修复台账（2026-07-03）

> 由 `npm run qa:insert-drift`（`scripts/qa/insert-column-drift-check.mjs`）扫出：
> 代码 `.insert/.update/.upsert` 写了**生产不存在的列**，每次调用 PGRST204 → 500。
> 与 groups.slug（已修）同一类根因。**30 处真实发现，18 个文件。**
>
> ⚠️ **修前先核实**：不能盲目"加列"。示例——Stripe 代码写 `user_profiles.stripe_customer_id`，
> 但该列由 00079 加在 **user_levels**（存在）不是 user_profiles；正解可能是**改代码写对表**，
> 加列到 user_profiles 反而掩盖真 bug。每条都要读 handler 判断：加列 / 改列名 / 改表 / 删该键。

## 分类（按用户影响 + 修法）

### A. 支付流（最高影响 — 收入相关，最需谨慎）

- `user_profiles.stripe_customer_id`（7 处：verify-session / checkout / create-api-checkout /
  create-checkout / webhook handlers）——**疑写错表**。00079 把该列加在 user_levels/subscriptions
  （均存在）。核实：应写 user_levels 还是 subscriptions，还是 user_profiles 真需要此列。
- `subscriptions.plan`（多处 upsert）——subscriptions 有 `tier` 无 `plan`。核实：用 tier 还是加 plan 列。
- `subscriptions.cancel_at_period_end` / `canceled_at`（webhook subscription/refund）——标准 Stripe
  字段，无迁移。核实：加列（boolean/timestamptz）还是映射到现有 status。
  → **PRO_FREE_PROMO 可能一直在掩盖 subscription webhook 同步静默失败**，务必查。
- `user_profiles.nft_token_id` / `nft_minted_at`（membership/nft、webhook/nft）——NFT 会员。核实加列。

### B. 版主/审核

- `content_reports.reviewer_id`（5 处：moderation-queue、reports）——表有 resolved_by/reporter_id，
  无 reviewer_id。疑列名错→应为 resolved_by/reviewed_by（需读）。
- `comments.deleted_at` / `deleted_by` / `delete_reason`（群评论删除、moderation-queue）——posts 有
  这三列软删，comments 没有。核实：加列做软删，还是改成硬删。

### C. 其他写路径

- `oauth_states.code_verifier`（exchange oauth authorize）——PKCE 需存 code_verifier。疑真缺列→加列。
- `gifts.to_user_id`（tip）——gifts 有 from_user_id + group_id/post_id，无 to_user_id。核实打赏收款人模型。
- `trader_attestations.trader_handle` / `attestation_uid` / `published_at` / `updated_at`（attestation/mint）。
- `trader_sources.nickname` / `description` / `verified` / `last_updated`（trader/sync upsert）——
  trader_sources 有 handle 无 nickname。疑列名错。
- `user_profiles.display_name`（auto-post-market-summary cron）——user_profiles 有 handle 无 display_name。疑列名错。
- `subscriptions`（account/delete、sync-subscription）canceled_at 等 — 同支付簇。

## 修复流程（每条）

1. 读该 handler 的写点，判断：**加列**（code intent 明确、mirror 现有模式）/ **改列名**
   （camelCase 或写错名，正列已存在）/ **改表**（写错表，正表有该列）/ **删该键**（多余）。
2. 加列走 `scripts/new-migration.sh` → `apply_migration` → `npm run qa:schema`。
3. 改代码后 `npm run qa:insert-drift` 应减少对应发现。
4. 若能，跑对应流程 e2e 验证（Stripe 用 webhook 重放 / 测试事件）。

## 已修（本轮，作为范式）

- `groups.slug`：migration 20260702234121 加列，apply 到生产，真 API 建群 200 验证。

**守卫已上**：`npm run qa:insert-drift` 现在是常态检查，任何新的列漂移会被抓。建议接入 CI/pre-push。
