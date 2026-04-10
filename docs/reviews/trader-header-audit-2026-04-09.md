# TraderHeader Audit (2026-04-09)

> Read-only audit produced by the Explore agent for a future data-flow
> refactor. **No code was changed.** This document is the input for the
> next refactor session.

## Summary

| Metric | Value |
|---|---|
| **Current props** | 40 (declared) |
| **Props actually used** | 28 (6 are dead code with `_` prefix) |
| **Realistic target after refactor** | ~16–20 props |
| **Net trim potential** | 20–24 props (50–60% reduction) |
| **Riskiest part** | Follower-count animation (currently uses `prevFollowerCountRef`); TraderHeader sits on the core path |
| **Quick win available** | Yes — 6 dead props can be deleted now (30 min, zero risk) |

## File reviewed

`app/components/trader/TraderHeader.tsx` (370 lines, was 581)

## Callers (2)

### 1. `app/(app)/trader/[handle]/TraderProfileClient.tsx` (core path)

Passes ~28 props. Data sources:
- `traderProfile` — from `/api/traders/[handle]?include=claim,aggregate,rank_history` (merged endpoint)
- `traderPerformance` — same endpoint, under `.performance`
- `data` — server prop (`UnregisteredTraderData`)
- `claimedUser` — server prop
- `linkedAccounts` — `useLinkedAccounts()` hook
- `currentUserId` — `useAuthSession()` hook
- `isVerifiedTrader` — bundled claim data

### 2. `app/(app)/u/[handle]/components/TraderProfileView.tsx` (claimed user profile)

Passes ~21 props. Data sources mirror caller 1, but uses
`useLinkedAccounts()` hook + parent-passed `currentUserId` + `isPro`.

## Prop categorization

### A. Static / identity — must stay as props (6)

| Prop | Type | Why it can't move to a hook |
|---|---|---|
| `traderId` | `string` | Composite key — component doesn't know which trader without it |
| `handle` | `string` | Display name + needed to construct API URLs if self-fetching |
| `source` | `string` | Exchange identifier — needed for API routing |
| `traderKey` | `string` | Trader's unique ID on exchange — needed for `(platform, traderKey)` lookup |
| `isOwnProfile` | `boolean` | Determines UI mode (edit vs view); local business logic |
| `currentUserId` | `string \| null` | Auth state — comes from parent's `useAuthSession()` |

**Rule**: a hook would need these as parameters anyway. Keeping them as props is correct.

### B. Plumbed data — move to `useTraderHeader()` hook (19)

These are all fetched by the parent from `/api/traders/[handle]`. TraderHeader could fetch directly via SWR.

| Prop | Current source | Suggested hook field |
|---|---|---|
| `displayName` | `traderProfile.display_name` | `useTraderHeader().displayName` |
| `avatarUrl` | `traderProfile.avatar_url` | `.avatarUrl` |
| `coverUrl` | `traderProfile.cover_url` | `.coverUrl` |
| `followers` | `traderProfile.followers` | `.followers` (mutable) |
| `aum` | (not currently fetched) | new field needed |
| `roi90d` | `traderPerformance.roi_90d` | `.performance.roi90d` |
| `arenaScore` | `traderPerformance.arena_score_90d` | `.performance.arenaScore90d` |
| `scoreConfidence` | `traderPerformance.score_confidence` | `.performance.scoreConfidence` |
| `tradesCount` | `traderPerformance.trades_count` | `.performance.tradesCount` |
| `rank` | `data.rank` (server prop) | currently from leaderboard, not detail API |
| `tradingStyle` | `traderPerformance.trading_style` | `.performance.tradingStyle` |
| `lastUpdated` | `traderData.lastUpdated` or `trackedSince` | `.lastUpdated` |
| `claimedBio` | `claimedUser.bio` or `traderProfile.bio` | needs `useVerifiedTrader()` |
| `claimedAvatarUrl` | `claimedUser.avatar_url` | needs `useVerifiedTrader()` |
| `isVerifiedTrader` | bundled `claim_status` | from claim bundle |
| `isBot` | `data.source === 'web3_bot'` | derived in hook |
| `linkedPlatforms` | `linkedAccounts.map(a => a.platform)` | already a hook (`useLinkedAccounts()`) — could compose internally |
| `dataSource` | enum from detail | `.dataSource` |
| `isAuthorized` / `authorizedSince` | bundled in detail | `.authorization` |

### C. UI state — keep internal or move to Zustand (3)

| Prop | Type | Recommendation |
|---|---|---|
| `proBadgeTier` | `'pro' \| null` | Could stay; tied to `isPro` (verify coupling) |
| `activeSince` | `string` | Could fetch with detail bundle |
| `isRegistered` | `boolean` | Stays — derived identity flag |

The truly internal pieces (`followerAnimating`, `handleCopied`, `showMiniHeader`) are already local component state, not props.

### D. Callbacks — typically stay (1)

| Prop | Should move? |
|---|---|
| `onFollowChange` | Could be removed — TraderHeader only forwards to `TraderHeaderActions` child. If `Actions` mutates local state directly (or via Zustand follower slice), the callback is unnecessary. |

### Dead code — delete now (6 props, zero risk)

These are declared in the interface but prefixed with `_` because they're never read:

| Prop | Line |
|---|---|
| `uid` → `_uid` | 91 |
| `following` → `_following` | 96 |
| `isPro` → `_isPro` | 101 |
| `maxDrawdown` → `_maxDrawdown` | 104 |
| `winRate` → `_winRate` | 105 |
| `profileUrl` → `_profileUrl` | 120 |

**Quick win**: removing these 6 + updating 2 callers = 30 min agent time, no behavior change. Trim 40 → 34.

> Note: `maxDrawdown` and `winRate` being unused in the *header* doesn't mean they're unused — they're consumed by sibling components. Verify before deletion that the parent isn't passing them by mistake (i.e. dead at the prop boundary, not dead globally).

## Existing hooks that already cover Category B

| Hook | Location | Provides |
|---|---|---|
| `useTraderDetailV2` | `lib/hooks/useTraderDetailV2.ts` | `/api/trader/{platform}/{traderKey}` — full detail + refresh |
| `useLinkedAccounts` | `lib/hooks/useLinkedAccounts.ts` | `/api/traders/aggregate?platform=...&trader_key=...` |
| `useAuthSession` | `lib/hooks/useAuthSession.ts` | Current user ID (no API call — Supabase auth context) |
| Generic SWR fetcher | `lib/hooks/useSWR.ts` | Used by current callers |

## Missing hooks needed

1. **`useTraderHeader(handle, source?, includeVerified?)`**
   - Wraps `/api/traders/[handle]?include=claim,aggregate,rank_history`
   - Returns: `{avatar, cover, displayName, followers, performance, linkedPlatforms, isVerified, ...}`
   - Status: **partially exists** via direct SWR in caller — needs extraction + memoization
2. **`useFollowerAnimation(followers)`**
   - Manages follower count state + animation flag
   - Status: **needs to be created** — currently inline in TraderHeader's `prevFollowerCountRef`

## Refactor plan (4 tiers, can be sequenced)

| Tier | Scope | Effort (agent-time) | Trim | Risk |
|---|---|---|---|---|
| **1. Quick win** | Delete 6 dead props + update 2 callers | 30 min | 40 → 34 | 🟢 Zero |
| **2. Extract `useTraderHeader()`** | Create hook from parent's SWR fetch, handle bundled data dedup, pass identity props only | 2-3 hr | 34 → ~20 | 🟡 Moderate |
| **3. Zustand follower slice** | Move follower count + mutation to Zustand, drop `onFollowChange` | 1-2 hr | 20 → ~18 | 🟢 Low |
| **4. `useVerifiedTrader()`** | Extract claimed user bio/avatar to dedicated hook | 1 hr | 18 → ~16 | 🟢 Low |

**Total effort**: 5-7 agent hours for full refactor, **40 → ~16 props (60% trim)**.

## Riskiest parts (mitigations)

1. **Follower animation logic** (lines 128-139)
   - Currently tracks prop change via `prevFollowerCountRef`
   - If `followers` is self-fetched, mutation timing becomes critical
   - **Mitigation**: Create `useFollowerAnimation(followers)` hook with debounce
2. **Core path regression**
   - TraderHeader is on the critical homepage → rankings → trader detail path
   - Any self-fetch delay breaks perceived performance
   - **Mitigation**: Use SWR's deduping + fallback data from server render; add Suspense boundary
3. **Claim data bundling** (lines 244-260 in caller)
   - Currently bundled via `include=claim` URL param
   - **Mitigation**: Keep bundling in the new hook — don't split into separate calls
4. **Avatar fallback ordering** (lines 183, 242-245)
   - Prefers `claimedAvatarUrl` over `avatarUrl`
   - **Mitigation**: Hook must prioritize claimed data; fall back to exchange avatar

## Recommendation for next session

Start with **Tier 1** as a 30-min stand-alone PR. It's a guaranteed-safe trim
40 → 34 with no design decisions. Verify the dead props really are unused at
the prop boundary (not just inside TraderHeader.tsx but globally).

If Tier 1 lands cleanly, proceed to **Tier 2** as the main refactor. Skip
Tiers 3 + 4 unless follower animation or claim flickering becomes a concern
during Tier 2.

---

*Audit produced by Explore agent in background, manually saved by main session.*
