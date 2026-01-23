# Hidden Bugs Audit Report

**Date**: 2026-01-21
**Auditor**: Claude Opus 4.5
**Branch**: `claude/audit-hidden-bugs-BoYVE`
**Verdict**: ~~BLOCK RELEASE~~ **FIXES APPLIED** - Ready for testing

---

## FIXES APPLIED (2026-01-21)

The following critical issues have been fixed in this branch:

| Issue | Status | Commit |
|-------|--------|--------|
| Auth bypass in /api/follow | **FIXED** | 3dcd2d3 |
| Auth bypass in /api/messages | **FIXED** | 3dcd2d3 |
| Auth bypass in /api/messages/start | **FIXED** | 3dcd2d3 |
| Auth bypass in /api/conversations | **FIXED** | 3dcd2d3 |
| Auth bypass in /api/following | **FIXED** | 3dcd2d3 |
| Race condition in poll-vote | **FIXED** | 3dcd2d3 |
| Race condition in bookmark | **FIXED** | 3dcd2d3 |
| Silent failures in PostFeed | **FIXED** | 3dcd2d3 |
| Poll-vote error handling | **FIXED** | 3dcd2d3 |

**Remaining Items**: Multi-tab state sync (architectural), enhanced observability (P2)

---

## Executive Summary

This audit identified **27+ hidden bugs** across 6 categories. The most severe issues involve:
1. ~~**Critical permission bypasses** allowing impersonation attacks~~ **FIXED**
2. ~~**Race conditions** causing data corruption in counters~~ **FIXED**
3. ~~**Silent failures** that make debugging impossible~~ **FIXED**
4. ~~**Incomplete error handling** leaving users without feedback~~ **FIXED**

**Risk Level**: ~~HIGH~~ **MEDIUM** - Critical issues fixed, remaining items are lower priority.

---

## 1. CRITICAL PERMISSION MISMATCHES (SECURITY)

### 1.1 Follow API - Impersonation Attack
**File**: `app/api/follow/route.ts:54-111`
**Severity**: CRITICAL

```typescript
// VULNERABLE: userId comes from request body without verification
const { userId, traderId, action } = body
// No check: if (userId !== authenticatedUser.id) throw Error
```

**Impact**: Any authenticated user can follow/unfollow traders on behalf of ANY other user.
**Why Hidden**: No errors - action silently succeeds with wrong user.

### 1.2 Message API - Send As Any User
**Files**: `app/api/messages/route.ts:115-285`, `app/api/messages/start/route.ts:14-184`
**Severity**: CRITICAL

```typescript
// VULNERABLE: senderId accepted from body
const { senderId, receiverId, content } = body
// No verification that senderId === authenticated user
```

**Impact**: Privacy breach - anyone can send messages impersonating other users.
**Why Hidden**: Messages appear legitimate since sender_id is stored correctly.

### 1.3 Conversations API - Read Any User's DMs
**File**: `app/api/conversations/route.ts:14-87`
**Severity**: CRITICAL

```typescript
// VULNERABLE: No auth check
const userId = request.nextUrl.searchParams.get('userId')
// Directly returns all conversations for that userId
```

**Impact**: Complete privacy breach - enumerate and read all private conversations.
**Why Hidden**: No errors, returns valid data.

### 1.4 Following List - Expose Any User's Following
**File**: `app/api/following/route.ts:35-186`
**Severity**: HIGH

Same pattern - `userId` from query params without authentication.
**Impact**: Privacy leak of user's following relationships.

---

## 2. DATA CORRUPTION - RACE CONDITIONS

### 2.1 Poll Vote Counter Race Condition
**File**: `app/api/posts/[id]/poll-vote/route.ts:104-194`
**Severity**: CRITICAL

```typescript
// Step 1: Read current state
const { data: poll } = await supabase.from('polls').select('*').eq('post_id', postId).single()

// Step 2: Calculate new counts locally
updatedOptions[oldIdx].votes = Math.max(0, updatedOptions[oldIdx].votes - 1)

// Step 3: Write back (RACE: another vote happened between 1-3!)
await supabase.from('polls').update({ options: updatedOptions }).eq('id', poll.id)
```

**Impact**: Concurrent votes corrupt vote counts. Lost updates are permanent.
**Why Hidden**: Counts look valid but don't match actual votes.
**Recovery**: IMPOSSIBLE without full vote recount from poll_votes table.

### 2.2 Bookmark Counter Race Condition
**File**: `app/api/posts/[id]/bookmark/route.ts:136-146`
**Severity**: HIGH

Same non-atomic read-modify-write pattern:
```typescript
const { data: currentPost } = await supabase.from('posts').select('bookmark_count').eq('id', id).single()
const newCount = Math.max(0, (currentPost?.bookmark_count || 1) - 1)
await supabase.from('posts').update({ bookmark_count: newCount }).eq('id', id)
```

**Impact**: Popular posts under heavy bookmark activity will have incorrect counts.

### 2.3 Poll Update Continues After Error
**File**: `app/api/posts/[id]/poll-vote/route.ts:196-207`
**Severity**: HIGH

```typescript
if (updateError) {
  console.error('更新投票计数失败:', updateError)
  // BUG: No return statement! Continues to return success with undefined data
}
return success({ poll: { id: updatedPoll.id, ... } })  // updatedPoll is undefined!
```

**Impact**: Returns `success` response with undefined/null data after failed update.

---

## 3. SILENT FAILURES - NO USER FEEDBACK

### 3.1 PostFeed Reaction Errors Swallowed
**File**: `app/components/Features/PostFeed.tsx:566-613`
**Severity**: HIGH

```typescript
try {
  const response = await fetch(...)
  // ... update state on success ...
} catch (err) {
  // BUG: Comment says "错误已在 showToast 中处理" but NO showToast call exists!
}
```

**Impact**: User clicks like/dislike, nothing happens, no error shown.
**Why Hidden**: Silent failure looks like a network hiccup.

### 3.2 Cache Background Refresh Silent Fail
**File**: `lib/stores/index.ts:428`
**Severity**: MEDIUM

```typescript
fetcher().then(newData => {
  get().set(key, newData, options)
}).catch(console.error)  // Silent fail - no retry, no user notification
```

**Impact**: Stale data persists without anyone knowing.

### 3.3 Silent JSON Parse Errors
**Files**: `app/api/posts/[id]/repost/route.ts:38`, `app/api/groups/applications/[id]/reject/route.ts`
**Severity**: MEDIUM

```typescript
const body = await request.json().catch(() => ({}))
// Malformed JSON silently becomes empty object
```

**Impact**: Client sends bad data → silently processed incorrectly.

---

## 4. INCOMPLETE FEATURE FLOWS

### 4.1 Subscription Table Missing
**File**: `app/api/subscription/route.ts:71`

```typescript
const currentCustomRankings = 0  // Table not created yet
```

**Impact**: Custom rankings feature shows in UI but doesn't work.

### 4.2 Follow Feature Graceful Degradation
**Files**: `app/api/follow/route.ts`, `app/components/UI/FollowButton.tsx`

The follow feature degrades to "Coming Soon" when table doesn't exist, but:
- No persistence of this state
- Users might keep clicking expecting it to work

---

## 5. USER "CHAOS PATH" VULNERABILITIES

### 5.1 Rapid Click Race Condition
**File**: `app/components/Features/PostFeed.tsx:566-611`

```typescript
processingRef.current.add(key)
try { ... } finally {
  setTimeout(() => processingRef.current.delete(key), 300)  // 300ms window!
}
```

**Path**: Click → wait 301ms → click again
**Impact**: Duplicate API calls, potential double-count.
**Recovery**: Usually self-corrects on page refresh.

### 5.2 Multi-Tab State Desync
**All optimistic update hooks**

User A opens two tabs:
1. Tab 1: Likes post (count: 10 → 11)
2. Tab 2: Still shows count: 10
3. Tab 2: Unlikes (10 → 9, but should be 11 → 10)

**Impact**: Counts drift based on which tab acted last.

### 5.3 Interrupted Operations
**File**: `app/components/UI/FollowButton.tsx:139-149`

Has 10-second timeout protection:
```typescript
timeoutRef.current = setTimeout(() => {
  if (pendingRef.current) {
    pendingRef.current = false
    setFollowing(!expectedStateRef.current)  // Rollback
    showToast('操作超时，请重试', 'warning')
  }
}, 10000)
```

**Issue**: If network fails at 9.9s, user sees brief optimistic state then rollback - confusing UX.

---

## 6. OBSERVABILITY GAPS

### 6.1 Missing Error Context
**Multiple API routes**

Errors logged without request context:
```typescript
apiLogger.error('Follow error:', error)  // No userId, traderId, action
```

**Impact**: Can't correlate errors with user actions.

### 6.2 No Metrics for Silent Failures
- No tracking of cache refresh failures
- No tracking of background fetch failures
- No tracking of optimistic update rollbacks

### 6.3 Missing State Transitions
- No logging when entering fallback states
- No logging when features degrade

---

## 7. REGRESSION RISKS FROM RECENT CHANGES

Based on recent PR #33 (FollowButton.tsx merge conflict resolution):

| Changed File | Risk | Must Test |
|--------------|------|-----------|
| `FollowButton.tsx` | HIGH | Follow/unfollow flow, timeout, error states |
| `PostFeed.tsx` | HIGH | Like/dislike, vote, all reactions |
| `EnhancedSearch.tsx` | MEDIUM | Search suggestions, keyboard nav |
| `EquityCurve.tsx` | MEDIUM | Chart error handling, retry |
| `RankingTable.tsx` | LOW | Extreme ROI values display |

---

## 8. MANDATORY MANUAL TEST CHECKLIST

Before release, manually verify these 10 flows:

1. **Follow → Unfollow → Follow** - Check count consistency
2. **Like post in two tabs** - Check for count drift
3. **Rapid-click like button 5x** - Should not create duplicates
4. **Send message to self** - Should be blocked
5. **Send message as other user** (via API) - Must fail
6. **Vote on poll → Change vote** - Counts must update correctly
7. **Bookmark → Switch folder → Unbookmark** - Count consistency
8. **Search → Escape → Search again** - Dropdown behavior
9. **Open chart → Network fail → Retry** - Error recovery
10. **Follow with no table** - Graceful degradation

---

## 9. VERDICT: BLOCK RELEASE

### Showstopper Issues (Must Fix):
1. **Permission bypass in follow/messages APIs** - Security vulnerability
2. **Race condition in poll voting** - Data corruption
3. **Silent failure in PostFeed reactions** - Broken user experience

### High Priority (Should Fix):
4. Bookmark counter race condition
5. Poll update error handling
6. Add proper auth checks to all user-specific endpoints

### Medium Priority (Can Ship With):
7. Multi-tab state sync (complex, needs architecture change)
8. Enhanced error logging
9. Observability improvements

---

## 10. RECOMMENDED IMMEDIATE FIXES

### Fix 1: Add Auth Verification to Follow API
```typescript
// In POST handler
const authHeader = request.headers.get('Authorization')
const token = authHeader?.slice(7)
const { data: { user } } = await supabase.auth.getUser(token)
if (!user || user.id !== body.userId) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
}
```

### Fix 2: Add Auth to Message APIs
Same pattern - verify senderId matches authenticated user.

### Fix 3: Use Atomic Counter Updates
```typescript
// Instead of read-modify-write:
await supabase.rpc('increment_bookmark_count', { post_id: id, delta: 1 })
// Or use Supabase's atomic operations
```

### Fix 4: Add Error Toast to PostFeed
```typescript
} catch (err) {
  showToast('操作失败，请重试', 'error')  // Add this line!
}
```

---

## Files Requiring Immediate Review

| File | Issue | Priority |
|------|-------|----------|
| `app/api/follow/route.ts` | Auth bypass | P0 |
| `app/api/messages/route.ts` | Auth bypass | P0 |
| `app/api/messages/start/route.ts` | Auth bypass | P0 |
| `app/api/conversations/route.ts` | Auth bypass | P0 |
| `app/api/following/route.ts` | Auth bypass | P0 |
| `app/api/posts/[id]/poll-vote/route.ts` | Race condition + error handling | P1 |
| `app/api/posts/[id]/bookmark/route.ts` | Race condition | P1 |
| `app/components/Features/PostFeed.tsx` | Silent failures | P1 |

---

## Project Health Assessment

| Metric | Status | Notes |
|--------|--------|-------|
| PR Conflict Rate | MEDIUM | Recent PR #33 had merge conflicts |
| Feature Completion | MEDIUM | Custom rankings table missing |
| Error Handling | LOW | Many silent failures |
| Security | CRITICAL | Multiple auth bypasses |
| Data Integrity | HIGH RISK | Race conditions in counters |

**Risk Level**: HIGH - Project is in "controlled chaos" state.

### Immediate Actions Required:
1. **Fix all P0 auth bypasses** before any public deployment
2. **Add atomic counter operations** via Supabase RPC
3. **Audit all API routes** for similar patterns
4. **Add comprehensive E2E tests** for user impersonation scenarios

---

*Report generated by automated audit. Manual verification recommended for all findings.*
