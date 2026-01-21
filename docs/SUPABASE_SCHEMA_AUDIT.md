# Supabase 架构审计报告

> 审计日期: 2026-01-21
> 修复日期: 2026-01-21
> 审计范围: supabase/migrations/ 全部迁移文件 + lib/types/ 类型定义
> 修复文件: `supabase/migrations/00011_fix_rls_security.sql`

---

## 一、表职责审计

### 【trader_snapshots】
- **当前用途**: 存储交易员排行快照数据
- **实际承担的职责数量**: 4个（排名、绩效指标、Arena 评分、时间序列）
- **是否职责过载**: ✅ 是
- **最危险的问题**: 一张表承担了"实时排名"+"历史快照"+"评分系统"三重身份，导致 UNIQUE 约束混乱 (`source, source_trader_id, season_id, captured_at`)
- **严重程度**: 🔴 致命

### 【posts】
- **当前用途**: 存储用户帖子
- **实际承担的职责数量**: 3个（内容、投票统计、社交计数）
- **是否职责过载**: ✅ 是
- **最危险的问题**: 投票数据 (`poll_bull`, `poll_bear`, `poll_wait`) 直接嵌入，同时存在 `poll_id` 字段但无对应表
- **严重程度**: 🟠 高

### 【groups】
- **当前用途**: 存储群组信息
- **实际承担的职责数量**: 3个（基本信息、规则配置、统计计数）
- **是否职责过载**: ✅ 是
- **最危险的问题**: 规则存储三套 (`rules`, `rules_en`, `rules_json`)，无法确定哪个是权威来源
- **严重程度**: 🟠 高

### 【notifications】
- **当前用途**: 用户通知
- **实际承担的职责数量**: 2个（系统通知、社交通知）
- **是否职责过载**: ✅ 是
- **最危险的问题**: 字段命名在迁移过程中变化（`content`→`message`, `is_read`→`read`），新旧代码可能引用不同字段
- **严重程度**: 🟠 高

### 【user_profiles】
- **当前用途**: 用户个人资料
- **实际承担的职责数量**: 4个（身份、社交统计、订阅状态、封禁状态）
- **是否职责过载**: ✅ 是
- **最危险的问题**: `subscription_tier` 同时存在于 `user_profiles` 和 `subscriptions` 表，需要 trigger 同步
- **严重程度**: 🟡 中

### 【subscriptions】
- **当前用途**: 用户付费订阅
- **实际承担的职责数量**: 3个（订阅状态、用量限制、Stripe 集成）
- **是否职责过载**: ✅ 是
- **最危险的问题**: `api_calls_today`, `comparison_reports_this_month`, `exports_this_month` 与订阅状态混在一起
- **严重程度**: 🟡 中

### 【alert_configs】 vs 【alert_config】
- **当前用途**: 前者是用户预警配置，后者是系统配置
- **实际承担的职责数量**: 各1个
- **是否职责过载**: ❌ 否
- **最危险的问题**: 命名仅差一个 `s`，极易混淆
- **严重程度**: 🟡 中

---

## 二、字段语义审计

### 冲突字段对

| 字段对 | 位置 | 危险原因 | 严重程度 |
|--------|------|----------|----------|
| `user_id` vs `author_id` | comments, posts | ~~同一概念，不同命名~~ **经验证：comments 和 posts 均使用 `author_id`，RLS 一致** | ~~🔴 致命~~ → ✅ 已验证 |
| `is_read` vs `read` | notifications, risk_alerts | 同一语义，不同命名。前端代码需同时处理两种写法 | 🟠 高 |
| `content` vs `message` | notifications | 通知内容字段名不一致，00001 用 `content`，00010 用 `message` | 🟠 高 |
| `tier` vs `subscription_tier` | subscriptions, user_profiles | 同一概念，一处用 `tier`，一处用 `subscription_tier`，需要 trigger 同步 | 🟠 高 |
| `status` | 8个表 | 每张表的 status 含义不同：订阅状态、申请状态、投诉状态、举报状态等 | 🟡 中 |
| `type` | notifications, alert_configs, content_reports | 分别表示通知类型、预警类型、举报类型，枚举值完全不同 | 🟡 中 |
| `role` | user_profiles, group_members | 前者是 `user\|admin`，后者是 `owner\|admin\|member`，语义重叠但不兼容 | 🟡 中 |
| `rules` vs `rules_json` vs `rules_en` | groups, group_edit_applications, group_applications | 三种规则存储方式同时存在 | 🟡 中 |
| `created_at` 时区 | 全部表 | 有的用 `TIMESTAMP WITH TIME ZONE`，有的 `TIMESTAMPTZ`（实际相同但看起来不一致） | 🟢 低 |

---

## 三、RLS 审计

### 【notifications】 ✅ 已修复
- **读规则**: 用户只能看自己的通知
- **写规则**: ~~`INSERT` 允许任何人~~ → 只允许 service_role 或用户给自己
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🔴 致命~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 14-25 行

### 【risk_alerts】 ✅ 已修复
- **读规则**: 用户只能看自己的预警
- **写规则**: ~~`INSERT` 允许任何人~~ → 只允许 service_role
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🔴 致命~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 31-37 行

### 【push_notification_logs】 ✅ 已修复
- **读规则**: 用户只能看自己的日志
- **写规则**: ~~`INSERT` 允许任何人~~ → 只允许 service_role
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🟠 高~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 43-55 行

### 【pro_official_groups】 ✅ 已修复
- **读规则**: ~~只有 `tier = 'pro'`~~ → `tier IN ('pro', 'elite', 'enterprise')`
- **写规则**: 无明确策略
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🟠 高~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 118-135 行

### 【group_applications】 ✅ 已修复
- **读规则**: 用户看自己的 + 群组管理员 + 站点管理员
- **写规则**: 群组 owner/admin 或站点管理员可更新
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🔴 致命~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 61-116 行

### 【posts】 ✅ 已修复
- **读规则**: 所有人可读
- **写规则**: 作者、群组管理员、站点管理员可删
- **存在"我也看不懂"的规则**: ❌ 否（已修复）
- **严重程度**: ~~🟠 高~~ → 🟢 已解决
- **修复**: `00011_fix_rls_security.sql` 第 141-166 行

### 【subscriptions】
- **读规则**: 用户只能看自己的 + service_role 可看全部
- **写规则**: 只有 service_role 可写
- **存在"我也看不懂"的规则**: ❌ 否，这个设计合理
- **严重程度**: 🟢 低

### 【trader_*】 所有交易员数据表
- **读规则**: 所有人可读
- **写规则**: 只有 service_role 可写（通过不设置 INSERT/UPDATE 策略实现）
- **存在"我也看不懂"的规则**: ❌ 否，但需要确认 service_role 配置正确
- **严重程度**: 🟢 低

---

## 四、幽灵数据审计

### 可疑表/字段

| 表/字段 | 可能来源 | 状态 |
|---------|----------|------|
| `posts.poll_id` | 初始设计有独立 poll 表，后来改为直接嵌入 `poll_bull/bear/wait` | 🟡 幽灵字段，前端已不用 |
| `groups.rules`, `groups.rules_en` | 早期多语言方案，后改用 `rules_json` | 🟡 可能是幽灵字段 |
| `trader_sources.handle` | 与 `trader_snapshots` 中的数据重复，通过 JOIN 获取 | 🟡 数据冗余 |
| `comments.author_handle` | 作者昵称反规范化存储，但用户可以改昵称 | 🟡 可能过期 |
| `posts.author_handle` | 同上 | 🟡 可能过期 |
| `oauth_states` | 在迁移文件中被引用但未见创建语句 | 🟠 可能是幽灵表 |
| `translation_cache` | 被引用但未见创建语句 | 🟠 可能是幽灵表 |
| `saved_filters` | 被引用但未见完整定义 | 🟠 可能是幽灵表 |

---

## 五、权限与产品逻辑一致性检查

### 权限错位点

| 问题 | 前端限制 | 后端实际 | 被滥用风险 | 状态 |
|------|----------|----------|------------|------|
| 通知插入 | 前端只在特定事件触发通知 | ~~RLS 允许任何人~~ → 只允许 service_role | ~~🔴 高~~ → 🟢 安全 | ✅ 已修复 |
| 群组帖子删除 | 前端 UI 让群组管理员有删除按钮 | ~~RLS 只允许作者~~ → 允许群组管理员 | ~~🔴 高~~ → 🟢 一致 | ✅ 已修复 |
| 群组申请审核 | 前端让群组 owner 处理申请 | ~~RLS 只允许站点 admin~~ → 允许群组 admin | ~~🔴 致命~~ → 🟢 一致 | ✅ 已修复 |
| Pro 功能访问 | 前端检查 `tier in ['pro', 'elite', 'enterprise']` | ~~RLS 只检查 'pro'~~ → 检查所有付费层级 | ~~🔴 高~~ → 🟢 一致 | ✅ 已修复 |
| 帖子创建 | 前端检查 `auth.uid() = author_id` | 初始策略只检查 `auth.role() = 'authenticated'` | 🟡 **中** — 已在 00010 修复 | ⚠️ 需验证 |
| 用量限制 | 前端检查 `subscriptions` 表中的限额 | 无 RLS 或 trigger 强制限额 | 🟡 **中** — 可通过直接 API 绕过 | ⚠️ 未修复 |

---

## 六、最小稳定核心识别

### 必须保留的表（核心功能）

| 表名 | 理由 |
|------|------|
| `auth.users` | Supabase 内置，用户认证基础 |
| `user_profiles` | 用户身份，被所有功能引用 |
| `trader_sources` | 交易员身份映射，核心业务 |
| `trader_snapshots` | 排行榜数据来源，核心业务 |
| `posts` | 社区内容主体 |
| `comments` | 社区互动基础 |
| `groups` | 社区结构基础 |
| `group_members` | 群组权限基础 |
| `user_follows` | 社交关系基础 |
| `subscriptions` | 付费功能基础 |

### 可暂缓处理的表

| 表名 | 理由 |
|------|------|
| `trader_scores` | Arena Score 可以从 snapshots 实时计算 |
| `trader_equity_curve` | 详情页数据，不影响核心排行 |
| `trader_position_history` | 详情页数据 |
| `trader_portfolio` | 详情页数据 |
| `trader_asset_breakdown` | 详情页数据 |
| `trader_stats_detail` | 详情页数据 |
| `mv_leaderboard` | 物化视图，可重建 |
| `mv_hot_posts` | 物化视图，可重建 |
| `cron_logs` | 运维数据，不影响用户功能 |
| `admin_logs` | 运维数据 |
| `push_subscriptions` | 推送功能，非核心 |
| `push_notification_logs` | 推送日志 |
| `pro_official_groups` | Pro 功能，用户少 |
| `avoid_votes` | 风险警告，独立功能 |
| `risk_appeals` | 风险申诉，独立功能 |
| `group_complaints` | 投诉系统，低频 |
| `group_leader_elections` | 选举系统，低频 |
| `bookmark_folders` | 收藏夹，非核心 |
| `folder_subscriptions` | 收藏订阅，非核心 |

---

## 七、最小整理顺序（可回滚）

### Step 1: 修复致命 RLS 漏洞
- **目标**: 堵住 `notifications`, `risk_alerts`, `push_notification_logs` 的 INSERT 漏洞
- **操作**: 将 `WITH CHECK (true)` 改为 `WITH CHECK (auth.role() = 'service_role')`
- **回滚**: 改回 `WITH CHECK (true)`
- **风险**: 低 — 前端本来就不直接插入这些表

### Step 2: 修复群组申请 RLS
- **目标**: 让群组 owner/admin 能审核申请
- **操作**: 在 `group_applications` UPDATE 策略中增加群组角色检查
- **回滚**: 删除新增的策略
- **风险**: 低 — 只是放宽权限

### Step 3: 修复 Pro 功能 RLS
- **目标**: 让 elite/enterprise 用户也能访问 pro 内容
- **操作**: 将 `tier = 'pro'` 改为 `tier IN ('pro', 'elite', 'enterprise')`
- **回滚**: 改回 `tier = 'pro'`
- **风险**: 低

### Step 4: 添加群组管理员删帖能力
- **目标**: 让群组 admin 能删除群内帖子
- **操作**: 新增 DELETE 策略检查 group_members 角色
- **回滚**: 删除新增策略
- **风险**: 中 — 需要测试不影响普通用户删帖

### Step 5: 统一字段命名（仅新代码）
- **目标**: 新代码统一使用 `is_read`, `author_id`
- **操作**: 不改数据库，只在代码层统一处理
- **回滚**: 无需回滚
- **风险**: 低

---

## 总结

### 修复前

| 维度 | 🔴 致命 | 🟠 高 | 🟡 中 | 🟢 低 |
|------|---------|-------|-------|-------|
| 表职责混乱 | 1 | 3 | 3 | 0 |
| 字段语义冲突 | 1 | 3 | 4 | 1 |
| RLS 安全问题 | 3 | 3 | 0 | 2 |
| 幽灵数据 | 0 | 0 | 5 | 2 |
| 权限错位 | 1 | 3 | 2 | 0 |

### 修复后 (00011_fix_rls_security.sql)

| 维度 | 🔴 致命 | 🟠 高 | 🟡 中 | 🟢 低 | ✅ 已修复 |
|------|---------|-------|-------|-------|-----------|
| 表职责混乱 | 1 | 3 | 3 | 0 | 0 |
| 字段语义冲突 | 0 | 3 | 4 | 1 | 1 |
| RLS 安全问题 | 0 | 0 | 0 | 2 | **6** |
| 幽灵数据 | 0 | 0 | 5 | 2 | 0 |
| 权限错位 | 0 | 0 | 2 | 0 | **4** |

### 已修复问题

1. ✅ **notifications/risk_alerts/push_notification_logs INSERT 漏洞** — 只允许 service_role
2. ✅ **group_applications RLS** — 群组 owner/admin 现在可以审核申请
3. ✅ **pro_official_groups RLS** — elite/enterprise 用户现在可以访问
4. ✅ **群组管理员删帖** — 群组 admin 现在可以删除群内帖子和评论
5. ✅ **comments 表字段一致性** — 确认使用 `author_id`，RLS 策略正确

### 仍需关注（但非紧急）

1. 🟡 表职责过载（trader_snapshots、posts、groups）— 需要架构重构
2. 🟡 字段命名不一致（is_read vs read、tier vs subscription_tier）— 需要代码层适配
3. 🟡 幽灵数据（poll_id、rules_en）— 需要清理

---

## 附录：辅助函数

修复中添加了以下辅助函数，简化后续 RLS 策略编写：

```sql
-- 检查是否为群组管理员
is_group_admin(p_group_id UUID) RETURNS BOOLEAN

-- 检查是否为站点管理员
is_site_admin() RETURNS BOOLEAN

-- 检查是否为付费用户
is_premium_user() RETURNS BOOLEAN
```

---

*审计报告更新于 2026-01-21，已包含修复状态*
