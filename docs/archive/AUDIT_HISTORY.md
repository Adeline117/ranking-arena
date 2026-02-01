# Audit History

This document consolidates all audit reports conducted across the Ranking Arena project.

**Last Updated**: 2026-01-28

---

## Table of Contents

1. [Community & Product Audit (Jan 2026)](#community-product-audit)
2. [State Management & API Audit (Jan 2026)](#state-management-api-audit)
3. [Database Schema Audit (Jan 2026)](#database-schema-audit)
4. [Internationalization Hardcode Audit (Jan 2026)](#i18n-hardcode-audit)

---

## Community & Product Audit

> Source: ARENA_COMMUNITY_AUDIT_REPORT.md
> Audit Date: 2026-01-21
> Audit Scope: Cold start risks, community quality, Pro value, data credibility, development pace, user confusion, narrative consistency

### 1. Cold Start Failure Risk Analysis

#### Leaderboard Empty State Risk

| Breakpoint | Trigger Condition | Severity |
|------------|-------------------|----------|
| PnL Threshold Filter | 7D requires >$300, 30D >$1000, 90D >$3000. New traders struggle to make the list | 🔴 High |
| Data Freshness | Only returns data from last 24h, cron failure = complete empty | 🔴 High |
| Exchange Single Point Failure | GMX has no 90D data, slow to integrate new exchanges | 🟡 Medium |

**Current Empty State Handling**:
- Shows "No trader data available" static text
- No CTA to guide users what to do
- No "upcoming leaderboard" preview queue

#### Community Cold Start Breakpoints

| Breakpoint | Current State | Risk |
|------------|---------------|------|
| Empty Group Posts | New groups show "No posts" | 🔴 User churn |
| Empty Following List | "Not following anyone" with no recommendations | 🔴 Cannot form social graph |
| Empty Hot List | Depends on `hot_score` algorithm, cold start = no hot posts | 🟡 Content discovery fails |
| Empty Comments | "No comments yet, be the first" but no incentive | 🟡 Engagement fails |

#### Minimum Fix Tactics

1. **Seed Content**: Pre-populate 10-20 official high-quality posts
2. **Leaderboard Degradation**: When PnL filter results in <20 traders, auto-lower threshold to show "Observation List"
3. **Empty State Conversion**: Show "Recommended TOP5" or "Popular Groups" on empty lists
4. **First Comment Reward**: Give Pro badge visibility boost to first commenters

### 2. Community Content Degradation Path Audit

#### Degradation Risk Path

```
Stage 1: Normal content
    ↓
Stage 2: Trader showing off → causes following/signal calls
    ↓
Stage 3: Group owners promote paid groups/signals → ad spam
    ↓
Stage 4: Losing users vent emotions → junk content
    ↓
Stage 5: Quality users leave → community death
```

#### Current Protection Capabilities

| Protection Layer | Implemented | Missing |
|------------------|-------------|---------|
| Report Mechanism | ✅ Category reports (spam/harassment/misinformation) | ❌ No auto-detection |
| Admin Moderation | ✅ Backend ReportsTab | ❌ No AI assist |
| Group Owner Governance | ✅ Democratic complaints → voting removal (>100 member groups) | ❌ Small groups no constraints |
| Mute Functionality | ✅ Admins can mute members | ❌ No auto-mute |

#### Missing Critical Protections

1. **No Sensitive Word Filter**: Keywords like "signal", "follow me", "DM", "WX", "Telegram" not intercepted
2. **No Post Rate Limit**: Can spam posts infinitely
3. **No Link/QR Code Detection**: External links and redirect images unlimited
4. **No New User Cooldown**: Can post immediately after registration
5. **No Content Quality Scoring**: Low quality content not downranked

#### Features That Need Pre-emptive Limits

| Feature | Current State | Suggested Limit |
|---------|---------------|-----------------|
| Posting | Unlimited | New users can post after 24h, daily limit 10 posts |
| DM | Unlimited | Must follow before DM, prevent harassment |
| Create Group | Unlimited | Account 7+ days old + 3 posts |
| Comment with Links | Allowed | Prohibit or require moderation |

### 3. Pro Subscription Value Assessment (Paying User Perspective)

#### Pricing Overview

| Plan | Original | Current | Monthly Equivalent |
|------|----------|---------|-------------------|
| Monthly | $15 | $9.9 | $9.9 |
| Annual | $180 | $99.9 | $8.3 |

#### Benefit Value Analysis

| Benefit | Value Judgment | Reason |
|---------|----------------|--------|
| Category Rankings | 🟡 Low value | Data unchanged, just filter view |
| Trader Change Alerts | 🟢 Valuable | But needs quality implementation, currently just DM |
| Arena Score Sub-scores | 🟡 Low value | Total score sufficient for decisions |
| Advanced Filters | 🟡 Low value | Users rarely use complex filters |
| Trader Comparison | 🟢 Valuable | Comparison is must-have, but 5 person limit too restrictive |
| Pro Badge | 🔴 Not worth it | Vanity attribute, no actual value |
| Pro Exclusive Group | 🟡 To be verified | Depends on group content quality |
| Historical Data 90D | 🟢 Valuable | Free 7D only is too short |
| API Access | 🟢 High value | Must-have for quant users |
| Data Export | 🟢 Valuable | But 10 times/month too few |

#### Worthless Benefits

1. **Pro Badge**: No social currency value, no one cares
2. **Category Rankings**: Filtering by type should be free
3. **Arena Score Sub-scores**: Too professional, average users don't understand percentiles

#### Must Enhance Points

| Benefit | Current | Suggestion |
|---------|---------|------------|
| Trader Comparison | 5 people/time, 10 times/month | 10 people/time, unlimited |
| Data Export | 10 times/month | 50 times/month or unlimited |
| Real-time Alerts | In-app DM | Add Email/Telegram/Webhook |
| Historical Data | 90D | Add 180D/365D |
| **Missing** | - | AI-generated trader deep analysis reports |
| **Missing** | - | Copy trading simulation backtest |
| **Missing** | - | Risk alert threshold customization |

#### Payment Conversion Obstacles

1. **No Free Trial**: Users cannot experience before paying
2. **No Exit Barriers**: Cancel subscription has no retention efforts
3. **Pro Group Value Not Demonstrated**: 500+ Pro members data is suspicious (hardcoded fake data on page)

### 4. Data Credibility Self-certification Capability Check

#### "Is This Data Real?" User Skepticism Response

| Skepticism Point | Can Self-certify | Missing Evidence |
|------------------|------------------|------------------|
| Data Source | ✅ Shows source badge | ❌ No exchange official endorsement |
| Update Time | ❌ Frontend doesn't show | Need "Data updated 2h ago" |
| Original Link | ✅ Has "View original page" | ✅ Traceable |
| Data Accuracy | ❌ Cannot prove | No third-party audit, no checksum |
| Arena Score Formula | ✅ Has documentation | But users won't read docs/ |

#### Cannot Self-certify Areas

1. **Data Scraping Completeness** - Currently only shows top 100, users can't know if there are omissions
2. **Data Tampering** - No blockchain proof, no third-party audit
3. **Historical Data Authenticity** - Only `captured_at` timestamp, no historical snapshot comparison
4. **Trader Identity Verification** - Avatar/nickname scraped from exchange, can't prove same person
5. **ROI Calculation Method** - Different exchange calculation logic, Arena hasn't unified explanation

#### Evidence Chain Needed

| Evidence | Implementation Difficulty | Priority |
|----------|--------------------------|----------|
| Frontend shows "Data updated time" | Low | 🔴 P0 |
| Data source disclaimer footer | Low | 🔴 P0 |
| Arena Score calculation explanation (simplified) | Low | 🟡 P1 |
| Exchange API screenshot archive | Medium | 🟡 P1 |
| Data difference explanation (different exchange ROI definitions) | Low | 🟡 P1 |
| Third-party audit report | High | 🟢 P2 |

### 5. Development Pace Assessment

#### Recent Development Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| 2025 YTD commits | 142 | High activity |
| Last 30 commit types | Lots of fix/debug/QA | 🟡 Fire-fighting mode |
| Feature files (.tsx) | 120+ | High complexity |
| Documentation files (.md) | 20+ | Documentation debt |

#### Commit Type Analysis

Recent commits show pattern:
```
fix: Fix all remaining z-index hardcode issues
fix: Unify z-index layer management with design tokens
fix: Fix file upload fake success issue
fix: Fix multiple component behavior breakpoint issues
fix: Fix multiple click no response issues
fix: QA functional testing improvements (16 issues)
```

**Problem**: Heavy fix commits indicate insufficient QA after feature development, causing significant rework later.

#### Is Overloaded?

🔴 **Yes, Obviously Overloaded**

1. **Feature Pileup**: Simultaneously pushing leaderboard, community, Pro, data scraping, mobile
2. **High Bug Density**: Recent commits 80%+ are fixes
3. **Documentation Redundancy**: Multiple overlapping optimization summary documents

#### Must Immediately Pause

| Item | Reason |
|------|--------|
| New feature development | Stabilize existing features first |
| Mobile Capacitor | Web not stable, dispersing focus |
| New exchange integration | Existing data sources already struggling to maintain |
| Pro feature expansion | Verify payment conversion first |

#### Should Immediately Do

1. **Feature Freeze**: No new features for 2 weeks
2. **Bug Bash**: Concentrate on fixing existing issues
3. **Documentation Cleanup**: Merge/delete redundant docs
4. **E2E Test Completion**: Prevent regression

### 6. User Confusion Point Identification

#### Definite User Confusion Areas

| Confusion Point | User Understanding | Actual Situation | Consequence |
|-----------------|-------------------|------------------|-------------|
| Arena Score | Higher is better, 100 max | Composite score, 70+ is already top tier | Users think 60 score is poor |
| ROI | Unified calculation standard | Different exchange definitions | Cross-exchange comparison meaningless |
| "500+ Pro Members" | Real data | Hardcoded fake data | Loss of trust |
| Following Traders | Will receive push notifications | Just list bookmark, no active notification (unless Pro) | Feature expectation fails |
| Max Drawdown | Lower is safer | Different time periods have different calculation bases | Misjudge risk |
| Leaderboard Real-time | Real-time updates | Fastest 15 min refresh (hot) / 4 hours (normal) | Miss best copy timing |

#### Serious Consequences of Confusion

1. **Arena Score Misjudgment** - Users may abandon quality 65-score traders, chase 90+ score but high-risk traders
2. **Cross-exchange ROI Comparison** - Binance ROI 90D and Bybit ROI 90D calculated differently, users directly compare numbers, make wrong decisions
3. **Fake Data Exposure** - "500+ Pro members" is hardcoded in `pricing/page.tsx:609`, once discovered, brand trust goes to zero

### 7. External Narrative Consistency Check

#### Page Narrative Comparison

| Page | Core Narrative | Problem |
|------|----------------|---------|
| Homepage | Trader leaderboard + community | Community entrance weak, no posts on first screen |
| Leaderboard | Arena Score rating system | Score explanation insufficient, users don't understand |
| Trader Page | Data transparency + one-click copy | No copy entrance, can only view |
| Pro Page | Risk management professional tools | Actual benefits lean toward data filtering |
| Pricing Page | "500+ Pro members trust us" | Fake data, contradicts trust narrative |

#### Narrative Conflicts

1. **"Data Transparency" vs No Data Update Time** - Homepage emphasizes transparency, but users can't see when data was updated
2. **"One-Stop Platform" vs No Copy Function** - Trader page has "Follow" but no "Copy", users need to jump to exchange
3. **"Community-Driven" vs Weak Community Entrance** - Homepage sidebar has post feed, but only visible on desktop, hidden on mobile
4. **"Professional Tools" vs Homogeneous Benefits** - Pro emphasizes professional, but benefits are all filtering/comparison, no professional analysis reports
5. **"500+ Pro Members" vs No Verification** - Pricing page shows in large text, but code has hardcoded fake data

#### Fix Recommendations

| Conflict | Fix Plan |
|----------|----------|
| Data transparency | Add "Data updated X minutes ago" |
| No copy function | Add "Go to exchange to copy" button, or clearly position as "selection" not copy |
| Weak community | Add community Tab to homepage, mobile bottom nav add community |
| Pro narrative | Add AI analysis reports, risk alerts and other professional features |
| Fake data | Use API to get real Pro user count, or delete this display |

### 8. Audit Summary

#### 🔴 Must Immediately Handle (P0)

1. Delete fake data (`500+ Pro members` - `app/pricing/page.tsx:609`)
2. Add data update time display
3. Feature freeze, concentrate on bug fixes
4. Empty state optimization, add CTAs

#### 🟡 Handle Short-term (P1, 2-4 weeks)

1. Community anti-spam mechanisms (post rate, sensitive words)
2. Pro benefit enhancement (comparison count, export times)
3. Unified narrative (copy positioning, community entrance)
4. Arena Score simplified explanation

#### 🟢 Medium-term Planning (P2, 1-3 months)

1. Free trial Pro
2. AI analysis reports (Pro exclusive)
3. Third-party data audit
4. Cold start seed content system

---

## State Management & API Audit

> Source: AUDIT_REPORT_2026-01-21.md
> Audit Date: 2026-01-21
> Audit Scope: State management, API contracts, concurrency handling, observability
> Status: ✅ Fixed (commit: e262e2d)

### 1. State Timeline Audit

#### 1.1 Leaderboard Trader Data State

**State Sources:**
- `lib/stores/index.ts:35` → `useRankingStore` (unused)
- `app/components/Home/hooks/useTraderData.ts:26` → `useState<Trader[]>` (actually used)

**Modification Path:**
```
Step 1: User visits homepage
       ↓
Step 2: useTraderData Hook initializes (line 31-39)
       → Read timeRange from localStorage
       ↓
Step 3: loadCurrentData() calls (line 71-84)
       → Call /api/traders?timeRange=xxx
       ↓
Step 4: API returns data (route.ts:330-337)
       → { traders, timeRange, totalCount, lastUpdated }
       ↓
Step 5: setCurrentTraders(cached.traders) (line 75)
       → State updates
       ↓
Step 6: Silent refresh (line 99-110)
       → Background update every 10 minutes
       ↓
Step 7: Time range switch (line 114-116)
       → Trigger reload
```

**State Loss Points:**
- `useTraderData.ts:44-46`: useRef cache cleared on page refresh
- `useTraderData.ts:64-66`: No persistence on API failure

#### 1.2 User Follow State

**Modification Path:**
```
Step 1: Component mounts → useState(initialFollowing)
Step 2: useEffect checks actual state → GET /api/follow
Step 3: User clicks → Optimistic update + POST /api/follow
Step 4: API responds → Success confirm / Failure rollback
```

**State Loss Points:** Multi-window operations have unsynchronized state

### 2. Authenticity Verification

#### 2.1 Leaderboard Data

| Step | Verification Result | Location |
|------|-------------------|----------|
| Frontend display | ✅ | RankingTable.tsx |
| API return | ⚠️ Stale data no marker | route.ts:134-149 |
| Database | ✅ | trader_snapshots |
| After refresh | ⚠️ Memory cache cleared | useTraderData.ts |

#### 2.2 UI Illusion Locations

1. `route.ts:134-149`: Using stale data when 24h no new data but not marked
2. `FollowButton.tsx:107`: Optimistic update then network failure rollback delay

### 3. API Contract Issues

#### 3.1 Field Inconsistencies

| Frontend Expects | Backend Returns | Status |
|------------------|-----------------|--------|
| volume_90d | Not returned | ❌ |
| avg_buy_90d | Not returned | ❌ |
| win_rate | Normalized value | ⚠️ May be null |
| trades_count | trades_count | ⚠️ May be null |

#### 3.2 Nullability Errors

- Backend: `win_rate: number | null`
- Frontend: `win_rate?: number`
- Different semantics, inconsistent handling logic

### 4. Time-related Issues

1. **Timezone**: `setHours()` uses local timezone, `toISOString()` converts to UTC
2. **GMX Special Handling**: Excluded on 90D, users may be confused
3. **Sort Stability**: ✅ Multi-level sort + ID alphabetical

### 5. Concurrency Issues

#### 5.1 Protected

- FollowButton: pendingRef + isLoading

#### 5.2 Unprotected

- PostActions.tsx Action component: Fast double-click can trigger twice

#### 5.3 Multi-window

- Database idempotent, but window state not synchronized

### 6. Rollback Path

| Feature | Can Disable | Method | Impact |
|---------|-------------|--------|--------|
| Leaderboard | ✅ | Replace HomePage | Homepage unavailable |
| Follow | ⚠️ | API return tableNotFound | Notification exception |
| Community | ❌ | Coupled with groups | Wide-ranging impact |

### 7. User Pitfalls

1. Time range switch causes ranking dramatic change → user confusion
2. Missing data shows "—" → perceived as poor quality
3. Not logged in follow redirects → user churn
4. Search uses fake data → empty results

### 8. Missing Logs

| Location | Problem |
|----------|---------|
| useTraderData.ts | Cache hit no logging |
| FollowButton.tsx | Failure only Toast |
| route.ts | Errors only console.error |

### 9. Release Review

#### Fixed Status

| # | Risk Point | Severity | Status |
|---|------------|----------|--------|
| 1 | Zustand unused, state chaos | Medium | ✅ Added comments explanation |
| 2 | volume_90d/avg_buy_90d not returned | High | ✅ Deleted fields |
| 3 | Stale data no marker | Medium | ✅ Added isStale |
| 4 | Action no duplicate click prevention | High | ✅ Added processingRef |
| 5 | Search uses fake data | High | ✅ Connected to real API |
| 6 | Multi-window not synchronized | Medium | ✅ BroadcastChannel |
| 7 | Errors no Sentry | Medium | ✅ Integrated logger |

#### Conclusion: ✅ Can Launch (Core issues fixed)

### 10. Fix Checklist

#### P0 (within 24h) - ✅ Fixed

1. ✅ Delete unused fields in RankingTable Trader interface (volume_90d, avg_buy_90d)
2. ✅ Add processingRef to Action component for duplicate prevention
3. ✅ API errors integrated to Sentry (handleError function integrated logger.error)

#### P1 (within 1 week) - ✅ Fixed

4. ✅ Stale data API response adds `isStale: boolean` and `staleSources` fields
5. ✅ Search functionality implements real API (/api/search/suggestions)

#### P2 (follow-up) - ✅ Fixed

6. ⚠️ Zustand stores added comment explanation, kept for future migration
7. ✅ Use BroadcastChannel API to implement multi-window sync (lib/hooks/useBroadcastSync.ts)

---

## Database Schema Audit

> Source: SUPABASE_SCHEMA_AUDIT.md
> Audit Date: 2026-01-21
> Fix Date: 2026-01-21
> Audit Scope: supabase/migrations/ all migration files + lib/types/ type definitions
> Fix File: `supabase/migrations/00011_fix_rls_security.sql`

### 1. Table Responsibility Audit

#### trader_snapshots
- **Current Purpose**: Store trader ranking snapshot data
- **Actual Number of Responsibilities**: 4 (ranking, performance metrics, Arena scoring, time series)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: One table carries "real-time ranking" + "historical snapshot" + "scoring system" triple identity, causing UNIQUE constraint chaos (`source, source_trader_id, season_id, captured_at`)
- **Severity**: 🔴 Fatal

#### posts
- **Current Purpose**: Store user posts
- **Actual Number of Responsibilities**: 3 (content, vote statistics, social counts)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: Vote data (`poll_bull`, `poll_bear`, `poll_wait`) directly embedded, while `poll_id` field exists but no corresponding table
- **Severity**: 🟠 High

#### groups
- **Current Purpose**: Store group information
- **Actual Number of Responsibilities**: 3 (basic info, rule configuration, statistics counts)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: Rules stored in three sets (`rules`, `rules_en`, `rules_json`), cannot determine authoritative source
- **Severity**: 🟠 High

#### notifications
- **Current Purpose**: User notifications
- **Actual Number of Responsibilities**: 2 (system notifications, social notifications)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: Field naming changed during migration (`content`→`message`, `is_read`→`read`), old and new code may reference different fields
- **Severity**: 🟠 High

#### user_profiles
- **Current Purpose**: User personal profiles
- **Actual Number of Responsibilities**: 4 (identity, social statistics, subscription status, ban status)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: `subscription_tier` exists in both `user_profiles` and `subscriptions` tables, requires trigger to sync
- **Severity**: 🟡 Medium

#### subscriptions
- **Current Purpose**: User paid subscriptions
- **Actual Number of Responsibilities**: 3 (subscription status, usage limits, Stripe integration)
- **Responsibility Overload**: ✅ Yes
- **Most Dangerous Problem**: `api_calls_today`, `comparison_reports_this_month`, `exports_this_month` mixed with subscription status
- **Severity**: 🟡 Medium

#### alert_configs vs alert_config
- **Current Purpose**: Former is user alert config, latter is system config
- **Actual Number of Responsibilities**: 1 each
- **Responsibility Overload**: ❌ No
- **Most Dangerous Problem**: Names differ by only one `s`, extremely confusing
- **Severity**: 🟡 Medium

### 2. Field Semantics Audit

#### Conflicting Field Pairs

| Field Pair | Location | Danger Reason | Severity |
|------------|----------|---------------|----------|
| `user_id` vs `author_id` | comments, posts | **Verified: Both comments and posts use `author_id`, RLS consistent** | ✅ Verified |
| `is_read` vs `read` | notifications, risk_alerts | Same semantics, different naming. Frontend code needs to handle both | 🟠 High |
| `content` vs `message` | notifications | Notification content field name inconsistent, 00001 uses `content`, 00010 uses `message` | 🟠 High |
| `tier` vs `subscription_tier` | subscriptions, user_profiles | Same concept, one uses `tier`, one uses `subscription_tier`, requires trigger sync | 🟠 High |
| `status` | 8 tables | Each table's status has different meaning: subscription status, application status, complaint status, report status, etc. | 🟡 Medium |
| `type` | notifications, alert_configs, content_reports | Represent notification type, alert type, report type respectively, enum values completely different | 🟡 Medium |
| `role` | user_profiles, group_members | Former is `user|admin`, latter is `owner|admin|member`, semantics overlap but incompatible | 🟡 Medium |
| `rules` vs `rules_json` vs `rules_en` | groups, group_edit_applications, group_applications | Three rule storage methods exist simultaneously | 🟡 Medium |
| `created_at` timezone | all tables | Some use `TIMESTAMP WITH TIME ZONE`, some `TIMESTAMPTZ` (actually same but looks inconsistent) | 🟢 Low |

### 3. RLS Audit

#### notifications ✅ Fixed
- **Read Rule**: Users can only see their own notifications
- **Write Rule**: Only service_role or user to self
- **Incomprehensible Rules**: ❌ No (fixed)
- **Severity**: 🟢 Solved
- **Fix**: `00011_fix_rls_security.sql` lines 14-25

#### risk_alerts ✅ Fixed
- **Read Rule**: Users can only see their own alerts
- **Write Rule**: Only service_role
- **Incomprehensible Rules**: ❌ No (fixed)
- **Severity**: 🟢 Solved
- **Fix**: `00011_fix_rls_security.sql` lines 31-37

#### push_notification_logs ✅ Fixed
- **Read Rule**: Users can only see their own logs
- **Write Rule**: Only service_role
- **Incomprehensible Rules**: ❌ No (fixed)
- **Severity**: 🟢 Solved
- **Fix**: `00011_fix_rls_security.sql` lines 43-49

### 4. Migration Quality Issues

#### Duplicate Version Numbers
- **Problem**: Multiple migrations had version 00011
- **Impact**: Deployment failures
- **Resolution**: Renumbered to sequential versions

#### Missing Rollback Scripts
- **Problem**: Some migrations lack down migration
- **Impact**: Difficult to revert changes
- **Recommendation**: Add rollback scripts for all future migrations

#### Inconsistent Naming Conventions
- **Problem**: Some migrations use snake_case, others use descriptive names
- **Impact**: Hard to find specific migrations
- **Recommendation**: Standardize naming: `XXXXX_descriptive_name.sql`

### 5. Type Definition vs Database Schema

#### Mismatches Found

| Type File | Database Issue | Severity |
|-----------|----------------|----------|
| lib/types/trader.ts | Some fields optional in types but NOT NULL in database | 🟠 High |
| lib/types/post.ts | poll fields structure doesn't match database | 🟡 Medium |
| lib/types/premium.ts | subscription_tier enum may be out of sync | 🟡 Medium |

#### Recommendations

1. Generate TypeScript types from database schema automatically (use Supabase CLI)
2. Add CI check to verify type definitions match database schema
3. Use schema validation on API boundaries

### 6. Index and Performance

#### Missing Indexes (High Priority)

Based on common query patterns:

```sql
-- trader_snapshots lookups by source and time
CREATE INDEX idx_trader_snapshots_source_time
ON trader_snapshots(source, captured_at DESC);

-- posts by group and created time
CREATE INDEX idx_posts_group_created
ON posts(group_id, created_at DESC) WHERE deleted_at IS NULL;

-- notifications by user and read status
CREATE INDEX idx_notifications_user_read
ON notifications(user_id, read, created_at DESC);
```

### 7. Data Integrity Concerns

#### Foreign Key Cascades

Many foreign keys lack ON DELETE/ON UPDATE clauses:
- Could lead to orphaned records
- Recommendation: Add appropriate CASCADE or RESTRICT clauses

#### Soft Deletes Inconsistency

- Some tables use `deleted_at`
- Others have `is_deleted` boolean
- Some have no soft delete mechanism
- Recommendation: Standardize on `deleted_at TIMESTAMPTZ`

### 8. Security Findings

#### Service Role Bypass

Several tables allow service_role to bypass all RLS policies. While necessary for backend operations, this should be:
- Documented clearly
- Audited regularly
- Used sparingly

#### Public Insert Permissions

Before fixes, several tables allowed public INSERT:
- notifications
- risk_alerts
- push_notification_logs

**Status**: ✅ All fixed in migration 00011

### Audit Conclusion

**Critical Issues**: 3 (all fixed)
**High Priority Issues**: 8
**Medium Priority Issues**: 12
**Low Priority Issues**: 5

**Overall Assessment**: Database schema has grown organically with some technical debt accumulated. Core security issues have been addressed. Recommend scheduled schema review every quarter to manage complexity.

---

## I18n Hardcode Audit

> Source: I18N_HARDCODE_AUDIT.md
> Audit Date: 2026-01-21
> Scope: Scanned `app/components/` directory for hardcoded Chinese strings

### Overview

Found hardcoded Chinese strings in user-visible UI text throughout the component tree. These should be extracted to the i18n system for multilingual support.

### High Priority Fixes (User-Visible UI Text)

#### 1. StatsBar.tsx
**Lines**: 176-198
**Strings**:
- '活跃交易员' (Active Traders)
- '平均 ROI' (Average ROI)
- '最佳表现' (Best Performance)
- '数据源' (Data Sources)

**Recommendation**: Use `t('home.stats.activeTraders')` etc.

#### 2. MarketPanel.tsx
**Lines**: 141, 146
**Strings**:
- '请求超时，请稍后重试' (Request timeout, please try again later)
- '网络连接失败，请检查网络设置' (Network connection failed, please check network settings)

**Recommendation**: Use `t('errors.timeout')`, `t('errors.networkError')`

#### 3. PostFeed.tsx
**Lines**: Multiple locations
**Strings**:
- '获取帖子失败' (Failed to fetch posts)
- '加载失败' (Load failed)
- '无标题' (No title)
- '匿名' (Anonymous)
- '删除评论' (Delete comment)
- '确定要删除这条评论吗？' (Are you sure to delete this comment?)
- '删除帖子' (Delete post)
- '确定要删除这篇帖子吗？删除后无法恢复。' (Are you sure to delete this post? Cannot be recovered after deletion.)
- '小组' (Group)
- '取消置顶' / '置顶' (Unpin / Pin)
- '转发自' (Forwarded from)

**Recommendation**: Migrate to i18n

#### 4. Sparkline.tsx
**Lines**: 183, 201, 205, 327
**Strings**:
- '暂无数据' (No data)
- '数据不足' (Insufficient data)
- '趋势上涨' / '趋势下跌' (Trend up / Trend down)

**Recommendation**: Use `t('chart.noData')`, `t('chart.trend.up')` etc.

#### 5. TopNav.tsx
**Lines**: Multiple locations
**Strings** (aria-labels and alt text):
- "返回首页" (Return to homepage)
- "搜索交易员" (Search traders)
- "搜索" (Search)
- "通知" (Notifications)
- "用户菜单" (User menu)
- "头像" (Avatar)
- "用户菜单选项" (User menu options)
- "私信" (Direct message)

**Recommendation**: aria-label should also be internationalized for accessibility

### Medium Priority (Acceptable But Recommended Fix)

#### 6. PremiumGroupCard.tsx
**Lines**: 161, 164, 169
**Current**: Conditional checks like `language === 'en' ? 'Trial' : '试用中'`
**Recommendation**: Replace with proper i18n function calls for cleaner code

#### 7. Error Messages Throughout
Many components have hardcoded Chinese error messages that should use the error message system.

### Implementation Strategy

1. **Phase 1**: Extract all user-visible strings
   - StatsBar, MarketPanel, PostFeed, TopNav
   - Add to lib/i18n.ts

2. **Phase 2**: Extract aria-labels and alt text
   - Important for accessibility
   - Should support multiple languages

3. **Phase 3**: Error messages
   - Standardize error message handling
   - Create error message i18n keys

4. **Phase 4**: Dynamic content
   - Time formatters
   - Number formatters
   - Date formatters

### Testing Checklist

- [ ] All hardcoded strings identified
- [ ] Translation keys added to i18n system
- [ ] Both English and Chinese translations provided
- [ ] Components updated to use i18n
- [ ] Visual regression tests pass
- [ ] Accessibility tests pass (screen readers with different languages)

### Recommended i18n Structure

```typescript
// lib/i18n.ts additions
export const translations = {
  en: {
    home: {
      stats: {
        activeTraders: 'Active Traders',
        averageROI: 'Average ROI',
        bestPerformance: 'Best Performance',
        dataSources: 'Data Sources'
      }
    },
    errors: {
      timeout: 'Request timeout, please try again later',
      networkError: 'Network connection failed, please check network settings',
      // ... more errors
    },
    chart: {
      noData: 'No data available',
      insufficientData: 'Insufficient data',
      trend: {
        up: 'Trending up',
        down: 'Trending down',
        neutral: 'Neutral'
      }
    }
  },
  zh: {
    // Chinese translations...
  }
}
```

---

## Summary

This consolidated audit history captures all major audits conducted on the Ranking Arena platform. Each audit has identified specific issues and provided actionable recommendations. Many critical issues have been resolved, with remaining items prioritized for future work.

**For Current Issues**: Refer to active project documentation and CLAUDE.md
**For Historical Context**: This document provides complete audit trail

**Archived Source Documents** (available in `docs/archive/`):
- ARENA_COMMUNITY_AUDIT_REPORT.md
- AUDIT_REPORT_2026-01-21.md
- SUPABASE_SCHEMA_AUDIT.md
- I18N_HARDCODE_AUDIT.md
