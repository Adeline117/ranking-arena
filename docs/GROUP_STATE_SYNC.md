# Group State Synchronization Analysis

## Overview

This document analyzes the current state synchronization mechanisms in the group/community system and identifies potential consistency issues.

## Current Architecture

### State Management Pattern

The group system uses:
- **Direct Supabase queries** for data operations
- **Component-level useState** for local UI state
- **SWR** for data fetching with caching
- **No real-time subscriptions** (polling pattern)

### Data Flow

```
User Action → API Route → Supabase DB → Return Response → Update Local State
                                          ↓
                              Other clients unaware of changes
                              (requires manual refresh)
```

## State Entities

| Entity | Table | Key State Fields |
|--------|-------|------------------|
| Group | `groups` | `member_count`, `has_owner`, `created_by` |
| Membership | `group_members` | `role` (owner/admin/member), `muted_until` |
| Complaint | `group_complaints` | `status` (pending/voting/resolved/dismissed) |
| Election | `group_leader_elections` | `status` (open/voting/closed) |

## State Transition Flows

### Membership State Machine

```
non_member
    ↓ (POST /api/groups/[id]/members)
member
    ↓ (PUT /api/groups/[id]/members/[userId]/role)
admin
    ↓ (leader election win)
owner
```

### Complaint Resolution Flow

```
pending (1 complainant)
    ↓ (≥10% of members complain)
voting
    ↓ (≥50% vote for removal)
resolved → admin role removed
    OR
dismissed (vote fails)
```

### Leader Election Flow

```
open (accepting candidates)
    ↓ (admin starts voting)
voting (voting period active)
    ↓ (voting closes)
closed → highest vote getter becomes owner
         previous owner → admin
```

## Verified Consistency Mechanisms

### Role Validation
- ✅ API routes verify membership before operations
- ✅ Role hierarchy enforced (owner > admin > member)
- ✅ Only owners can transfer ownership

### Count Tracking
- ✅ `member_count` updated on join/leave
- ✅ Vote counts accurately tracked
- ✅ Complaint threshold (10%) calculated from member count

### Cascading Updates
- ✅ Election winners update `groups.created_by`
- ✅ Old owner demoted to admin automatically
- ✅ Complaint resolution removes admin role

## Identified Gaps

### No Real-Time Synchronization
**Impact**: Users don't see live updates for:
- Member joins/leaves
- Role changes
- New posts and comments
- Complaint status changes
- Election progress

**Workaround**: Manual page refresh required

### Potential Race Conditions
**Scenario 1**: Concurrent role updates
```
Admin A: promote B to admin
Admin C: kick B from group
Result: Inconsistent state possible
```

**Scenario 2**: Concurrent vote submissions
```
User 1: vote for candidate A
User 2: vote for candidate A
Database: may miss one vote
```

### No Transaction Guarantees
Multi-table updates (e.g., election completion) are not atomic:
```javascript
// Current implementation (non-atomic)
await supabase.from('group_members').update(...)
await supabase.from('groups').update(...)
// If second query fails, state is inconsistent
```

## Verification Queries

### Check Membership Consistency
```sql
-- Find groups where member_count doesn't match actual members
SELECT g.id, g.name, g.member_count,
       (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as actual_count
FROM groups g
WHERE g.member_count != (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id);
```

### Check Owner Consistency
```sql
-- Find groups with has_owner=true but no owner member
SELECT g.id, g.name
FROM groups g
WHERE g.has_owner = true
AND NOT EXISTS (
  SELECT 1 FROM group_members gm
  WHERE gm.group_id = g.id AND gm.role = 'owner'
);
```

### Check Election State Consistency
```sql
-- Find elections in 'closed' state without a winner recorded
SELECT ge.id, ge.group_id
FROM group_leader_elections ge
WHERE ge.status = 'closed'
AND ge.winner_id IS NULL;
```

### Check Complaint Vote Consistency
```sql
-- Find complaints where vote_count doesn't match actual votes
SELECT gc.id, gc.vote_count,
       (SELECT COUNT(*) FROM group_complaint_votes gcv WHERE gcv.complaint_id = gc.id) as actual_votes
FROM group_complaints gc
WHERE gc.vote_count != (SELECT COUNT(*) FROM group_complaint_votes gcv WHERE gcv.complaint_id = gc.id);
```

## Recommendations

### Short-term (No Architecture Changes)

1. **Add Periodic Sync Check**
   - Background job to verify consistency
   - Auto-fix discrepancies with logging

2. **Implement Optimistic Locking**
   - Add `version` column to critical tables
   - Check version before updates

3. **Add Error Recovery**
   - Client-side retry on failed operations
   - Toast notification for sync errors

### Medium-term (Minor Changes)

1. **Database Triggers for Count Sync**
   ```sql
   CREATE TRIGGER update_member_count
   AFTER INSERT OR DELETE ON group_members
   FOR EACH ROW
   EXECUTE FUNCTION sync_member_count();
   ```

2. **Add Supabase Realtime Subscriptions**
   ```typescript
   // Subscribe to group_members changes
   const subscription = supabase
     .channel('group-members')
     .on('postgres_changes', {
       event: '*',
       schema: 'public',
       table: 'group_members',
       filter: `group_id=eq.${groupId}`
     }, handleMemberChange)
     .subscribe()
   ```

### Long-term (Architecture Improvements)

1. **Use Database Transactions**
   - Wrap multi-table updates in transactions
   - Use Supabase RPC for atomic operations

2. **Event Sourcing**
   - Store all state changes as events
   - Rebuild state from event log

3. **CQRS Pattern**
   - Separate read and write models
   - Eventually consistent reads

## Monitoring

### Key Metrics to Track

- Group state sync errors per hour
- Member count discrepancy count
- Failed role update operations
- Time to eventual consistency (when implemented)

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Sync errors/hour | > 10 | > 50 |
| Count discrepancies | > 5 | > 20 |
| Failed operations | > 5% | > 10% |

## Related Files

- `/app/api/groups/[id]/members/[userId]/role/route.ts` - Role updates
- `/app/api/groups/[id]/complaints/[complaintId]/vote/route.ts` - Vote processing
- `/app/api/groups/[id]/leader-election/route.ts` - Election management
- `/app/groups/[id]/page.tsx` - Main group page with state management
- `/lib/stores/index.ts` - Zustand store definitions
