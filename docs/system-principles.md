# System Architecture Principles (Lockdown)

> **This document defines non-negotiable architectural rules.**
> Any PR that violates these principles MUST be rejected.
> These rules exist to prevent the "works on page A, broken on page B" class of bugs.

---

## 1. Auth Chain: Single Source of Truth

### Rule: All client-side auth state must come from `useUnifiedAuth()`

```typescript
// CORRECT
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'

function MyComponent() {
  const auth = useUnifiedAuth({
    onUnauthenticated: () => showToast('请先登录', 'warning'),
  })
  const token = auth.requireAuth() // returns null if not authenticated
}
```

```typescript
// FORBIDDEN - Direct supabase.auth calls in components/pages
supabase.auth.getSession()  // ← NEVER in component code
supabase.auth.getUser()     // ← NEVER in component code
```

### Rule: All server-side auth must use `requireAuth()` or `getAuthUser()`

```typescript
// CORRECT
import { requireAuth, getAuthUser } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const user = await requireAuth(request) // throws 401 if no valid token
  // user.id is the authenticated user - NEVER trust body/query params for identity
}
```

```typescript
// FORBIDDEN - Taking userId from request body
const { userId } = await request.json() // ← NEVER trust client-provided userId
```

### Rule: Write operations MUST NOT proceed without auth

- Client: `auth.requireAuth()` returns null → abort, show "please login"
- Server: `requireAuth()` throws 401 → caller catches and returns proper error
- Token expired → clear message "登录已过期", not generic "操作失败"

---

## 2. Data Chain: Canonical Store + Server ACK

### Rule: One cache key per entity

| Entity | Cache Key | Store |
|--------|-----------|-------|
| Post | `posts[postId]` | `usePostStore` |
| Comments | `comments[postId]` | `usePostStore` |
| Pagination | `commentsPagination[postId]` | `usePostStore` |

### Rule: All entry points read/write the same store

```typescript
// CORRECT - Store loaded data in canonical store
import { usePostStore, type PostData } from '@/lib/stores/postStore'

const storeSetPosts = usePostStore(s => s.setPosts)
// After fetching posts from API:
storeSetPosts(canonicalPosts)
```

### Rule: UI updates ONLY after server ACK

```typescript
// CORRECT - Wait for server response before updating store
const result = await submitPostComment(postId, content, token)
if ('error' in result) {
  showToast(result.error, 'error') // Show error, don't update UI
} else {
  // Store already updated by submitPostComment after server ACK
}
```

```typescript
// FORBIDDEN - Optimistic update that can't be reconciled
setComments(prev => [...prev, fakeComment]) // ← shows then disappears on refetch
```

### Rule: Comment ordering is explicit

- All comments are ordered by `created_at ASC` (oldest first)
- This is enforced in `loadPostComments()` and `loadMorePostComments()`
- No component may re-sort comments

---

## 3. Navigation Chain: URL-Driven State

### Rule: Modals/overlays must be URL-driven

```typescript
// CORRECT - URL controls modal state
import { useUrlModal } from '@/lib/hooks/useUrlModal'

const postModal = useUrlModal({ paramName: 'post' })
// Open: postModal.open(postId) → URL becomes ?post=<id>
// Close: postModal.close() → removes ?post from URL
// ESC: automatically handled
// Back button: automatically handled (browser history)
```

```typescript
// FORBIDDEN - Pure memory modal state
const [openPost, setOpenPost] = useState(null) // ← no URL, no back button, no deep-link
```

### Rule: Click targets must be separated

```typescript
// CORRECT - Author link is independent, with stopPropagation
<Link
  href={`/u/${post.author_handle}`}
  onClick={(e) => e.stopPropagation()} // ← prevents parent onClick
>
  {post.author_handle}
</Link>
```

```typescript
// FORBIDDEN - Author name inside a clickable card with no separation
<div onClick={() => openPost(post)}>
  <span>{post.author_handle}</span>  // ← clicking author opens post, not profile
</div>
```

### Rule: Close/ESC/Back must all work consistently

- `useUrlModal` handles all three automatically via URL state
- Any modal component MUST use `useUrlModal` or equivalent URL-driven mechanism
- Manual `setOpenPost(null)` without URL update is forbidden

---

## 4. Prohibited Patterns (Anti-Regression)

| Pattern | Why It's Banned | Replacement |
|---------|----------------|-------------|
| `supabase.auth.getSession()` in pages | Creates parallel auth states | `useUnifiedAuth()` |
| `supabase.auth.getUser()` in pages | Same | `useUnifiedAuth()` |
| `userId` from request body | Allows impersonation | `requireAuth(request).id` |
| `senderId` from request body | Same | `requireAuth(request).id` |
| `setComments([...prev, fake])` before ACK | Ghost data | `submitPostComment()` |
| `useState` for modal open/close | No URL, no back | `useUrlModal()` |
| `router.push('/page')` for modal | Breaks back button | `useUrlModal().open()` |

---

## 5. PR Checklist (All Must Be Checked)

When submitting a PR that touches any of these areas, the author must confirm:

- [ ] **Auth**: Uses `useUnifiedAuth()` on client, `requireAuth()` on server
- [ ] **Server ACK**: No UI state updated before server confirms write operation
- [ ] **Canonical Store**: Entity data written to `postStore` (or equivalent)
- [ ] **URL-Driven**: Any modal/overlay state synced with URL params
- [ ] **Click Targets**: Author/group links use `<Link>` with `stopPropagation`
- [ ] **Error Messages**: Distinguishes 401/403/500 with user-facing text
- [ ] **No Optimistic Ghosts**: Refreshing the page shows the same data

---

## 6. File Reference

| File | Purpose |
|------|---------|
| `lib/hooks/useUnifiedAuth.ts` | Client-side auth singleton |
| `lib/hooks/useUrlModal.ts` | URL-driven modal state |
| `lib/stores/postStore.ts` | Canonical post/comment store |
| `lib/supabase/server.ts` | Server-side auth helpers |
| `app/components/post/PostDetailModal.tsx` | Shared modal component |
| `e2e/system-state-architecture.spec.ts` | Architecture verification tests |

---

## 7. Migration Status

### Fully Migrated (Auth + Data + Navigation)
- `app/hot/page.tsx`
- `app/messages/[conversationId]/page.tsx`
- `app/components/post/PostFeed.tsx`
- `app/api/follow/route.ts`
- `app/api/messages/route.ts`

### Pending Migration (Auth only - use `useUnifiedAuth`)
- 48 other pages/components still use direct supabase.auth calls
- These should be migrated incrementally using the same pattern
- Priority: pages with write operations (post creation, settings, groups)

---

## Enforcement

This document is enforced by:
1. **ESLint rule**: `no-restricted-imports` and `no-restricted-syntax` (see `.eslintrc.js`)
2. **E2E tests**: `e2e/system-state-architecture.spec.ts`
3. **PR template**: Checklist above must be completed
4. **Code review**: Any violation of these principles is a blocking review comment
