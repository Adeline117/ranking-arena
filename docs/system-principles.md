# System State Management Principles

> **This document is normative.** All new code MUST comply with these rules.
> Violations must be caught in code review or ESLint.

---

## 1. Single Source of Truth (Auth)

### Rule
All authentication state comes from `useAuthSession()` (defined in `lib/hooks/useAuthSession.ts`).

### What This Means
- One global singleton manages: `userId`, `email`, `accessToken`, `isLoggedIn`, `authChecked`
- Token refresh is handled transparently inside the hook
- All pages share the same state (no re-initialization per page)

### Prohibited Patterns
```typescript
// WRONG: Direct supabase auth calls in components
supabase.auth.getSession()
supabase.auth.getUser()
supabase.auth.onAuthStateChange(...)

// WRONG: Local auth state in pages
const [userId, setUserId] = useState(null)
const [accessToken, setAccessToken] = useState(null)
```

### Correct Pattern
```typescript
import { useAuthSession } from '@/lib/hooks/useAuthSession'

function MyComponent() {
  const { userId, email, isLoggedIn, authChecked, getAuthHeaders, requireAuth } = useAuthSession()
  // ...
}
```

---

## 2. Server ACK Before UI Success

### Rule
All write operations (comment, like, message, follow, bookmark, repost) must wait for server confirmation before showing success in the UI.

### What This Means
- UI shows "sending" state during the request
- On success: update UI with server-returned data
- On failure: show error state, user can retry
- The comment/message NEVER appears as "sent" until the server confirms

### Prohibited Patterns
```typescript
// WRONG: Optimistic success then refetch (comment appears then disappears)
setComments(prev => [...prev, newComment])  // appears immediately
await fetch('/api/comments', { method: 'POST', ... })
refetchComments()  // might overwrite local state

// WRONG: Fire-and-forget (no error handling)
fetch('/api/posts/like', { method: 'POST', ... })
setLiked(true)  // what if the request fails?
```

### Correct Pattern
```typescript
// Show sending state
setSubmitState('sending')

const response = await fetch('/api/posts/{id}/comments', {
  method: 'POST',
  headers: { ...getAuthHeaders(), ...getCsrfHeaders() },
  body: JSON.stringify({ content }),
})
const json = await response.json()

if (response.ok && json.success) {
  // Server ACK received - NOW update UI
  setComments(prev => [...prev, json.data.comment])
  setSubmitState('idle')
} else {
  // Show error - comment NOT added to UI
  setSubmitState('error')
  showToast(json.error, 'error')
}
```

### Unified Hooks
Use these instead of raw fetch for common operations:
- `usePostComments({ postId })` - comments with server ACK
- `usePostReaction()` - likes/dislikes with server ACK

---

## 3. URL-Driven UI State

### Rule
All overlays, modals, and detail views must sync their open/close state with the URL.

### What This Means
- Opening a post modal: URL becomes `?post={id}`
- Closing: URL param is removed
- Escape key, close button, backdrop click ALL update the URL
- Direct URL access opens the correct view
- Browser back button works correctly

### Prohibited Patterns
```typescript
// WRONG: Pure memory state for modals
const [isOpen, setIsOpen] = useState(false)
// User can't bookmark this state, back button doesn't work

// WRONG: Inconsistent close behavior
const close = () => setIsOpen(false)  // doesn't update URL
```

### Correct Pattern
```typescript
const router = useRouter()
const searchParams = useSearchParams()

// Open: update URL
const open = (postId: string) => {
  const params = new URLSearchParams(searchParams.toString())
  params.set('post', postId)
  router.replace(`/hot?${params.toString()}`, { scroll: false })
  document.body.style.overflow = 'hidden'
}

// Close: remove from URL
const close = () => {
  const params = new URLSearchParams(searchParams.toString())
  params.delete('post')
  router.replace(params.toString() ? `/hot?${params}` : '/hot', { scroll: false })
  document.body.style.overflow = ''
}

// Escape key handler
useEffect(() => {
  if (!isOpen) return
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}, [isOpen, close])
```

---

## 4. Click Target Isolation

### Rule
Interactive elements inside clickable cards must NOT trigger the outer card's click handler.

### What This Means
- Author names are `<Link>` to `/u/{handle}` with `e.stopPropagation()`
- Group names are `<Link>` to `/groups/{id}` with `e.stopPropagation()`
- The outer card click opens the post detail
- Inner links navigate to their respective pages

### Prohibited Patterns
```typescript
// WRONG: Author name is just text, not a link
<span>{post.author}</span>

// WRONG: Author link without stopPropagation (triggers card click too)
<Link href={`/u/${author}`}>{author}</Link>
```

### Correct Pattern
```typescript
<Box onClick={() => openPost(post)}>
  {/* Author link - stops propagation to outer card */}
  <Link
    href={`/u/${post.author_handle}`}
    onClick={(e) => e.stopPropagation()}
  >
    {post.author}
  </Link>

  {/* Group link - stops propagation to outer card */}
  {post.group_id && (
    <Link
      href={`/groups/${post.group_id}`}
      onClick={(e) => e.stopPropagation()}
    >
      {post.group}
    </Link>
  )}
</Box>
```

---

## 5. Auth-Gated Write Operations

### Rule
Write operations must check auth BEFORE making any API call. The UI must never "assume" the user is logged in.

### What This Means
- Check `isLoggedIn` before calling any mutation API
- If not logged in: show toast or redirect to login (never send the request)
- If token is expired: the server returns 401, client shows "session expired" (not generic error)
- If forbidden (403): show the specific reason (e.g., "DM disabled", "message limit reached")

### Error Classification
| Status | Client Message | Action |
|--------|---------------|--------|
| 401 (no token) | "请先登录" | Redirect to login |
| 401 (expired) | "登录已过期，请重新登录" | Try refresh, then redirect |
| 403 (forbidden) | Show `body.error` | No redirect, explain reason |
| 403 (limit) | "消息发送数量已达上限" | Show specific limit info |
| 500+ | "服务器错误，请稍后重试" | Allow retry |

---

## 6. Canonical Cache Keys

### Rule
The same entity must always use the same cache key, regardless of which page accesses it.

### What This Means
- Post comments are keyed by `post:{postId}:comments`
- A comment submitted on the hot page is the same data as on the groups page
- The unified hooks (`usePostComments`, `usePostReaction`) ensure this automatically

### Prohibited Patterns
```typescript
// WRONG: Different fetch URLs for same data in different pages
// hot page: fetch(`/api/hot-posts/${id}/comments`)
// groups page: fetch(`/api/groups/${gid}/posts/${id}/comments`)
```

---

## 7. How to Add New Features Correctly

When adding a new feature (e.g., bookmarks, reposts, new modals):

### Step 1: Auth
- Use `useAuthSession()` for auth state
- Guard write operations with `getAuthHeaders()`
- Never trust client-provided user IDs on the server (verify via JWT)

### Step 2: Data
- Create a hook in `lib/hooks/` if the feature involves data mutations
- Always wait for server ACK before updating UI
- Include `getCsrfHeaders()` on write requests

### Step 3: UI
- If opening an overlay/detail view: sync with URL params
- If adding clickable elements inside cards: use `stopPropagation()`
- Provide loading, error, and empty states

### Step 4: Testing
- Add E2E test in `e2e/system-state.spec.ts` for:
  - Auth boundary (unauthenticated user can't perform action)
  - Server ACK (action persists after refresh)
  - Navigation (URL state, escape key, back button)

---

## Enforcement

These rules are enforced by:
1. **ESLint**: `no-restricted-syntax` rules block direct `supabase.auth` calls in `app/`
2. **PR Template**: Mandatory checklist items for system state compliance
3. **E2E Tests**: `e2e/system-state.spec.ts` validates behavior continuously
4. **Code Review**: All PRs must confirm compliance with this document
