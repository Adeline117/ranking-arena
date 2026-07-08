# Post Interaction Bug Ledger — 2026-07-08

> **Status:** Documented only — fixes not started (per owner request).
> **Scope:** Upvote/downvote, bookmark, repost, comment input, comment votes, replies on `/post/[id]` and related feed surfaces.
> **Reported by:** User repro session 2026-07-08 (upvote +2 screenshots + follow-up interaction bugs).
> **Related audit IDs:** U8-3 (detail-page +2), U8-4 (comment scroll), U9-1 (count drift — partially data), U8 content-feed unit in `docs/UIUX_OVERHAUL_2026-07.md`.
> **Test cases:** `docs/QA_TEST_CASES.md` → TC-POST-006 (like/dislike), TC-POST-007 (bookmark).

---

## Summary

Post interactions (vote, bookmark, repost, comment) share the same broken patterns on `/post/[id]`:

1. **Dual state writes** — `usePostActions` calls both `setPosts` and `setOpenPost`, which alias the same `post` state on the detail page → **+2 upvotes** (VR-1) and erratic counts when bookmarking (VR-13).
2. **Repost modal focus glitch** — inline `onCancel` prop recreates every keystroke → focus stolen (VR-14).
3. **Repost counter never increments** — API + client both skip `repost_count`; UI hardcodes `0` (VR-15).
4. **Comment typing loses cursor** — parent re-renders + textarea auto-resize in scroll container (VR-16).
5. **Comment upvote scroll jump** — Wilson re-sort on every like toggles DOM order (VR-17).
6. **Replies don't nest** — optimistic path nests correctly but reload/sort/expansion edge cases leave replies invisible or flat (VR-18).

---

## Bug index

| ID | Sev | Symptom | Surfaces | Root cause (code) |
|----|-----|---------|----------|-------------------|
| VR-1 | **P0** | Upvote +1 click → count +2 | `/post/[id]` | Dual write: `setPosts` + `setOpenPost` alias same `post` state |
| VR-2 | **P1** | Downvote count never shown in detail actions | `/post/[id]`, feed modal via `PostDetailView` | `showCount={false}` on downvote `Action` |
| VR-3 | **P1** | Inconsistent reaction UX across pages | `/hot`, `/feed`, `/post/[id]`, groups | 4 separate client implementations |
| VR-4 | **P1** | Hot page uses `likes`/`dislikes`; feed uses `like_count`/`dislike_count` | `/hot` vs `/feed` | Parallel field names in `app/(app)/hot/types.ts` vs `PostWithUserState` |
| VR-5 | **P1** | Hot modal: no optimistic update; feels laggy | `/hot` post modal | `useHotPageData.toggleReaction` waits for server only |
| VR-6 | **P1** | Groups: like handler ignores server counts | `/groups/[id]` | `useGroupPosts.handleLike` toggles locally, discards API body |
| VR-7 | **P2** | Groups: no downvote UI | `/groups/[id]` | Like-only button; `user_liked` bool vs `user_reaction` enum |
| VR-8 | **P2** | U8-3 partial fix still incomplete | `/post/[id]`, feed modal | `openPostRef` added but **both** update paths still run |
| VR-9 | **P2** | Rollback/error paths repeat dual-write pattern | Detail + feed modal | Optimistic rollback calls both `setPosts` and `setOpenPost` |
| VR-10 | **P2** | Comment likes: non-atomic server path | Comment threads | `comments/like` uses SELECT→mutate→recount, not RPC |
| VR-11 | **P2** | Legacy modal bypasses shared hook | `PostDetailModal` (store-based) | Server-ACK-only via `postStore.togglePostReaction` |
| VR-12 | **P3** | Possible DB vs UI count drift on seed/bot posts | Bot posts (e.g. `@arena_bot`) | U9-1 noted some drift is bad seed data, not code |
| VR-13 | **P0** | Bookmark click → upvote/like count +2 (user report) | `/post/[id]` | Same dual-write class as VR-1; `handleBookmark` also calls `setPosts` + stale-closure `setOpenPost` |
| VR-14 | **P1** | Repost modal glitches/flickers on every keystroke | Repost modal (`RepostModal`) | `useEffect([onCancel])` + inline `onCancel` → cleanup restores pre-modal focus each render |
| VR-15 | **P1** | Repost counter doesn't increase after repost | `/post/[id]`, feed | API never increments `repost_count`; client never updates state; UI shows hardcoded `count={0}` |
| VR-16 | **P1** | Comment cursor jumps outside text box while typing | Comment input on detail/feed | Parent re-render on each char + textarea auto-height resize inside scrollable post view |
| VR-17 | **P1** | Comment upvote/downvote scrolls page up | Comment thread | `sortedComments` Wilson re-sort reorders DOM when `like_count` changes (default `best` sort) |
| VR-18 | **P1** | Reply doesn't appear nested under parent | Comment replies | Optimistic nest works in code; expansion/preview limit/reload flat list may hide or misplace reply |
| VR-19 | **P2** | Repost comment state lifts to `usePostActions` | Repost modal | `repostComment` in parent hook → full `PostDetailPageBody`/`PostFeed` re-render per keystroke |

---

## VR-1 — Upvote increments by 2 (P0)

### Repro

1. Log in.
2. Open any post detail page, e.g. `/post/<id>` (screenshot shows `@arena_bot` exchange-battle post).
3. Note upvote count (e.g. **0**).
4. Click **Upvote** once.
5. **Observed:** count becomes **2**, button highlights as active.
6. **Expected (TC-POST-006):** count **+1** only.

### Root cause

`PostDetailPageBody` adapts feed hooks to a single post by aliasing **`setPosts` and `setOpenPost` to the same `setPost` state**:

```75:94:app/(app)/post/[id]/PostDetailPageBody.tsx
  // Adapters so the feed hooks (which operate on arrays + an "open" post) drive
  // our single post. setPosts maps over a one-element array; setOpenPost routes
  // a null (delete) to navigation.
  const setPosts = useCallback<React.Dispatch<React.SetStateAction<Post[]>>>((action) => {
    setPost((prev) => {
      const next = typeof action === 'function' ? (action as (p: Post[]) => Post[])([prev]) : action
      return next[0] ?? prev
    })
  }, [])

  const setOpenPost = useCallback(
    (v: Post | null) => {
      if (v === null) {
        router.push('/hot')
        return
      }
      setPost(v)
    },
    [router]
  )
```

`usePostActions.toggleReaction` **always** applies an optimistic delta via **both** paths when `openPost.id === postId`:

```177:199:app/components/post/hooks/usePostActions.ts
      // Optimistic update — apply delta
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? {
                ...p,
                like_count: p.like_count + likeDelta,
                dislike_count: p.dislike_count + dislikeDelta,
                user_reaction: newReaction,
              }
            : p
        )
      )
      {
        const op = openPostRef.current
        if (op?.id === postId)
          setOpenPost({
            ...op,
            like_count: op.like_count + likeDelta,
            dislike_count: op.dislike_count + dislikeDelta,
            user_reaction: newReaction,
          } as Post)
      }
```

On the detail page both calls enqueue updates to the **same** `post` state. The inline comment documents this as **U8-3** (“a single like showed +2”). A July 2026 fix added `openPostRef` to avoid a stale closure, but **`setOpenPost` is still invoked**, so the double-write remains.

### Affected files

- `app/(app)/post/[id]/PostDetailPageBody.tsx` — state aliasing
- `app/components/post/hooks/usePostActions.ts` — dual optimistic update (lines ~177–199, ~227–230, ~249–258, ~276–285)
- `app/components/post/components/PostDetailActions.tsx` — UI showing `likeCount`

### Suggested fix direction (not implemented)

- On detail page: **only call one update path** (either drop `setOpenPost` when `setPosts`/`setOpenPost` are aliased, or pass a flag into `usePostActions`).
- Prefer functional `setPost(prev => …)` everywhere; never spread stale `openPostRef` literals onto aliased state.
- Add regression test: mount detail adapter + single upvote → assert `like_count` increments by exactly 1.

---

## VR-2 — Downvote count hidden on detail page (P1)

`PostDetailActions` renders upvote with `showCount={true}` but downvote with **`showCount={false}`**, so users never see dislike totals on the primary post detail action bar (matches user screenshot: “Downvote” with no number).

```60:87:app/components/post/components/PostDetailActions.tsx
      <Action
        icon={<ThumbsUpIcon size={14} />}
        text={t('upvote')}
        ...
        count={likeCount}
        showCount={true}
      />
      <Action
        icon={<ThumbsDownIcon size={14} />}
        text={t('downvote')}
        ...
        count={dislikeCount}
        showCount={false}
      />
```

**Contrast:** `PostCard.tsx` in the feed **does** show `dislike_count` on the down button.

---

## VR-3 — Fragmented reaction implementations (P1)

| Location | Hook / handler | Optimistic? | Fields used |
|----------|----------------|-------------|-------------|
| `PostFeed`, `/post/[id]` | `usePostActions.toggleReaction` | Yes | `like_count`, `dislike_count`, `user_reaction` |
| `/hot` | `useHotPageData.toggleReaction` | No | `likes`, `dislikes`, `user_reaction` |
| `lib/hooks/usePostInteraction.ts` | `usePostReaction` | Yes (callback-based) | Caller-dependent |
| `PostDetailModal` (store) | `postStore.togglePostReaction` | No (server ACK) | Store `PostData` |
| `/groups/[id]` | `useGroupPosts.handleLike` | Local toggle only | `user_liked`, `like_count` |

No single source of truth → fixes on one path (e.g. U8-3) do not fix others.

---

## VR-4 — Field name split on Hot page (P1)

Hot page types define parallel aliases:

```24:36:app/(app)/hot/types.ts
  comments: number
  likes: number
  like_count?: number
  ...
  dislikes?: number
  user_reaction?: 'up' | 'down' | null
```

`useHotPageData.toggleReaction` writes **`likes` / `dislikes`**, not `like_count` / `dislike_count`:

```688:698:app/(app)/hot/useHotPageData.ts
          setPosts((prev) =>
            prev.map((p) => {
              if (p.id === postId) {
                return {
                  ...p,
                  likes: result.like_count,
                  dislikes: result.dislike_count,
                  user_reaction: result.reaction,
                }
              }
```

Shared components expecting `like_count` may read stale/zero on hot-sourced posts.

---

## VR-5 — Hot page: no optimistic UI (P1)

Hot `toggleReaction` only updates state **after** `fetch(/api/posts/${id}/like)` succeeds. No optimistic delta, no in-flight lock beyond try/catch. UX: click feels unresponsive vs feed/detail.

---

## VR-6 — Groups like handler ignores server truth (P1)

```411:431:app/(app)/groups/[id]/hooks/useGroupPosts.ts
  const handleLike = useCallback(
    async (postId: string) => {
      ...
      const result = await apiCall(`/api/posts/${postId}/like`, { body: { reaction_type: 'up' } })
      if (result.ok) {
        setPosts((prev) =>
          prev.map((p) => {
            if (p.id !== postId) return p
            const wasLiked = p.user_liked
            return {
              ...p,
              user_liked: !wasLiked,
              like_count: wasLiked ? Math.max(0, (p.like_count || 0) - 1) : (p.like_count || 0) + 1,
            }
          })
        )
```

Problems:

- Response body (`like_count`, `dislike_count`, `reaction`) is **never applied**.
- Uses `user_liked` boolean — cannot represent downvote or up→down switch correctly.
- Local toggle can diverge from DB if user already reacted elsewhere (violates “server ACK” principle in `usePostInteraction.ts` header comment).

---

## VR-7 — Groups: no downvote (P2)

`PostListItem` in groups only renders a thumbs-up + count. No downvote control. API supports `reaction_type: 'down'` but UI does not.

---

## VR-8 — Incomplete U8-3 fix (P2)

`usePostActions.ts` lines 105–109 document U8-3 and add `openPostRef`, but optimistic + success + rollback blocks **still call `setOpenPost`** when IDs match. On aliased detail-page state this preserves the double-update class of bugs.

Prior audit note (`docs/UIUX_OVERHAUL_2026-07.md`, 2026-07-06) claimed U9-1 “-2 drift” on feed refresh was **seed data**, not code — distinct from VR-1 live +2 on click.

---

## VR-9 — Rollback paths duplicate the bug (P2)

On API failure or network error, `toggleReaction` reverses delta via **both** `setPosts` and `setOpenPost` with the same stale-`openPostRef` literal pattern (lines ~237–285 in `usePostActions.ts`). Can over/under-shoot counts on detail page during error recovery.

---

## VR-10 — Comment likes: non-atomic write path (P2)

Post reactions use atomic RPC `toggle_post_reaction` (`supabase/migrations/20260422114832_toggle_post_reaction_atomic.sql`).

Comment likes use **read-modify-write** in `app/api/posts/[id]/comments/like/route.ts` (SELECT existing → DELETE/UPDATE/UPSERT → recount). Higher TOCTOU risk under concurrent clicks; separate from post +2 but same “vote” family.

Client: `usePostComments.toggleCommentLike` / `toggleCommentDislike` — optimistic only (no dual-write to aliased state).

---

## VR-11 — Legacy `PostDetailModal` (P2)

`app/components/post/PostDetailModal.tsx` reads from Zustand `postStore` and calls `togglePostReaction` (server ACK only). Different component tree from `PostDetailView` / `PostDetailActions`. Any feed entry still using this modal won’t get `usePostActions` fixes.

---

## VR-12 — Data / seed drift (P3)

`docs/UIUX_OVERHAUL_2026-07.md` (2026-07-06): **U9-1** “-2 drift” on refresh attributed to **seed data**, not client code. Worth verifying `@arena_bot` posts: UI +2 on click is **VR-1** (client); persistent wrong totals after hard refresh may additionally be data.

---

## Server layer (verified OK for single increment)

- **API:** `POST /api/posts/[id]/like` → `togglePostReaction()` → RPC `toggle_post_reaction`.
- **RPC:** Single increment/decrement per action inside transaction (`20260422114832_toggle_post_reaction_atomic.sql`).
- **Triggers:** Non-atomic `like_count` triggers were dropped in `20260422115812_fix_cascade_and_counter_triggers.sql`.

If DB count is correct after refresh but UI shows +2 immediately, defect is **client-side (VR-1)**.

---

## VR-13 — Bookmark adds 2 upvotes (P0)

### Repro (user report, 2026-07-08)

1. Open `/post/[id]`.
2. Click **Bookmark** (not upvote).
3. **Observed:** upvote/like count increases by **2** (or vote count jumps erratically).
4. **Expected:** bookmark toggles independently; `like_count` unchanged.

### Root cause (code audit)

`handleBookmark` repeats the **same dual-write pattern** as `toggleReaction`:

```472:477:app/components/post/hooks/usePostActions.ts
          setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, bookmark_count: result.bookmark_count } : p))
          )
          if (openPost?.id === postId)
            setOpenPost({ ...openPost, bookmark_count: result.bookmark_count } as Post)
```

On `/post/[id]`, both `setPosts` and `setOpenPost` write the same `post` state (see VR-1). Unlike `toggleReaction`, bookmark success uses a **stale `openPost` closure** (not `openPostRef`), so the second write can **overwrite** the whole post object — including `like_count` / `user_reaction` — with an outdated snapshot. Interleaving bookmark + vote actions likely produces the reported +2 or count corruption.

Bookmark optimistic path only touches `userBookmarks` / `bookmarkCounts` maps (not `like_count` directly), so the bug manifests on **success reconcile** or when combined with prior VR-1 state.

### Affected files

- `app/components/post/hooks/usePostActions.ts` — `handleBookmark`, `handleBookmarkToFolder`
- `app/(app)/post/[id]/PostDetailPageBody.tsx` — aliased state adapters

---

## VR-14 — Repost modal glitches on every keystroke (P1)

### Repro

1. Open a post → click **Repost**.
2. Type in the optional comment textarea.
3. **Observed:** modal flickers / glitches per character (user report: "glitches for each word I type").
4. **Expected:** smooth typing like any other textarea.

### Root cause

`RepostModal` mounts a focus-management `useEffect` keyed on `onCancel`:

```36:71:app/components/post/Modals/RepostModal.tsx
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement
    const timer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 50)
    ...
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()  // ← restores focus on cleanup
    }
  }, [onCancel])
```

Callers pass an **inline** `onCancel` lambda that is recreated every render:

```286:289:app/(app)/post/[id]/PostDetailPageBody.tsx
          onCancel={() => {
            actions.setShowRepostModal(null)
            actions.setRepostComment('')
          }}
```

Each keystroke updates `repostComment` in `usePostActions` → parent re-renders → new `onCancel` identity → effect cleanup runs → **focus yanked back to pre-modal element** → effect re-runs → textarea refocused. Visually this reads as a per-character glitch.

Related: VR-19 — lifting `repostComment` to the parent hook forces the entire detail page tree to re-render on every keypress.

### Affected files

- `app/components/post/Modals/RepostModal.tsx`
- `app/(app)/post/[id]/PostDetailPageBody.tsx`
- `app/components/post/PostFeed.tsx` (same inline `onCancel` pattern)

---

## VR-15 — Repost counter never increases (P1)

### Repro

1. Repost a post successfully (toast "reposted").
2. Check repost count on original post.
3. **Observed:** counter stays at 0 / doesn't move (user report).
4. **Expected:** original post `repost_count` +1.

### Root cause — server

`POST /api/posts/[id]/repost` creates a new post but **never increments** `repost_count` on the original:

```66:107:app/api/posts/[id]/repost/route.ts
    const { data: newPost, error: insertError } = await supabase
      .from('posts')
      .insert({ ... original_post_id: rootPostId ... })
    ...
    return NextResponse.json({
      success: true,
      post_id: newPost.id,
      message: 'Repost successful',
    })
```

No `UPDATE posts SET repost_count = …` and no RPC/trigger found in migrations for repost increments.

### Root cause — client

`handleRepost` closes modal and shows toast but **does not update** `repost_count` in posts state or `setRepostCounts`:

```589:593:app/components/post/hooks/usePostActions.ts
        if (response.ok) {
          setShowRepostModal(null)
          setRepostComment('')
          trackEvent('post_repost', { post_id: postId, with_comment: comment ? 1 : 0 })
          showToast(t('reposted'), 'success')
```

Contrast: `useGroupPosts.handleRepost` expects `data.repost_count` from API — but the route doesn't return it.

### Root cause — UI

Detail action bar hardcodes repost display to zero and hides count:

```191:193:app/components/post/components/PostDetailActions.tsx
        active={false}
        count={0}
        showCount={false}
```

Even after server/client fixes, detail page wouldn't show the counter without wiring `post.repost_count`.

### Affected files

- `app/api/posts/[id]/repost/route.ts`
- `app/components/post/hooks/usePostActions.ts`
- `app/components/post/components/PostDetailActions.tsx`
- `app/(app)/groups/[id]/hooks/useGroupPosts.ts` (expects API field that isn't returned)

---

## VR-16 — Comment cursor leaves text box while typing (P1)

### Repro

1. Open post detail → focus the main comment textarea.
2. Type characters one at a time.
3. **Observed:** cursor/focus jumps outside the box (user report: "every letter I type … cursor goes outside the text box").
4. **Expected:** focus stays in textarea until user clicks away.

### Root cause (likely contributors)

**A. Parent re-render on every character**

`newComment` lives in `usePostComments` but is passed through `PostDetailView` → `CommentsModal` → `CommentInput`. Each `setNewComment` re-renders the full detail page tree (large component with translation, poll, actions, all comments).

**B. Auto-resize mutates textarea height every keystroke**

```71:77:app/components/post/comments/CommentInput.tsx
          onChange={(e) => {
            setNewComment(e.target.value)
            const ta = e.target
            ta.style.height = 'auto'
            ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
          }}
```

Height changes inside a scrollable post/article container can shift scroll position and move the caret visually relative to the viewport.

**C. Dynamic import wrapper**

`PostDetailView` uses `DynamicCommentsModal` (`next/dynamic`, `ssr: false`). Unlikely to remount after first load, but worth verifying during fix.

**D. Draft localStorage debounce** — `setNewComment` in hook debounces localStorage writes; shouldn't steal focus but adds work per keystroke.

### Affected files

- `app/components/post/comments/CommentInput.tsx`
- `app/components/post/CommentsModal.tsx`
- `app/components/post/components/PostDetailView.tsx`
- `app/(app)/post/[id]/PostDetailPageBody.tsx`

---

## VR-17 — Comment upvote/downvote scrolls up (P1)

### Repro

1. Open post with comments (default **Best** sort).
2. Scroll partway through comments.
3. Click upvote or downvote on a comment.
4. **Observed:** view scrolls upward (user report).
5. **Expected:** scroll position stable; only the button/count updates.

### Root cause

`CommentsModal` re-sorts comments on **every** `like_count` / `dislike_count` change when sort mode is `best` (default):

```99:124:app/components/post/CommentsModal.tsx
  const sortedComments = useMemo(() => {
    ...
    sorted.sort((a, b) => {
      const sa = wilson(a.like_count || 0, a.dislike_count || 0)
      const sb = wilson(b.like_count || 0, b.dislike_count || 0)
      if (sb !== sa) return sb - sa
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    return sorted
  }, [comments, commentSort])
```

Optimistic like toggle (`usePostComments.toggleCommentLike`) updates counts → Wilson score changes → **comment moves in DOM order** → browser scroll anchoring jumps. This is separate from the auto-scroll effect (which only fires on new `temp_` comments, U8-4).

### Affected files

- `app/components/post/CommentsModal.tsx`
- `app/components/post/hooks/usePostComments.ts`
- `app/components/post/comments/CommentThread.tsx`

---

## VR-18 — Reply doesn't appear under parent comment (P1)

### Repro (user report)

1. Click **Reply** on a comment.
2. Type and submit reply.
3. **Observed:** reply doesn't show nested underneath parent.
4. **Expected:** reply indented under parent (see `CommentThread` `isReply` layout).

### Code paths (audit)

**Submit path looks correct:**

```429:436:app/components/post/hooks/usePostComments.ts
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentId ? { ...c, replies: [...(c.replies || []), optimisticReply] } : c
        )
      )
      setReplyContent('')
      setReplyingTo(null)
      setExpandedReplies((prev) => ({ ...prev, [parentId]: true }))
```

**Load path nests replies** via `getPostComments` (`lib/data/comments.ts` — fetches `parent_id IS NULL` roots + batches replies into `replies[]`).

### Likely failure modes

| # | Scenario | Why reply looks missing |
|---|----------|-------------------------|
| 1 | Server POST succeeds but client replace fails | Optimistic reply rolled back; user sees nothing |
| 2 | `REPLIES_PREVIEW_COUNT = 2` + `expandedReplies` not set | New reply hidden behind "expand N replies" (mitigated: submit sets expanded) |
| 3 | Wilson re-sort after submit | Parent comment moves; user loses visual context (feels like reply vanished) |
| 4 | Reply input toggled off before submit completes | `setReplyingTo(null)` on submit start — if submit fails silently, user confused |
| 5 | Page reload | If `parent_id` not persisted server-side, reply would appear top-level — verify API POST with `parent_id` |
| 6 | Flat optimistic comment at root | Bug if `parentId` wrong — unlikely if user clicked Reply on that thread |

Needs runtime repro to distinguish API failure vs UI nesting vs sort jump.

### Affected files

- `app/components/post/hooks/usePostComments.ts` — `submitReply`
- `app/components/post/comments/CommentThread.tsx` — reply render tree
- `app/api/posts/[id]/comments/route.ts` — `parent_id` handling
- `lib/data/comments.ts` — `getPostComments` nesting

---

## VR-19 — Repost state lifted too high (P2)

`repostComment` / `setRepostComment` live in `usePostActions`, co-located with feed posts, bookmarks, reactions. Every character typed in the repost modal re-renders all consumers of `usePostActions` output — amplifies VR-14 focus glitch and general jank.

**Fix direction:** colocate repost draft state inside `RepostModal` (local `useState`) or isolate modal in a memoized boundary; stabilize `onCancel` with `useCallback`.

---

## Recommended fix order (when approved)

1. **VR-1 / VR-8 / VR-9 / VR-13** — Single state write on detail page; `openPostRef` everywhere; skip duplicate `setOpenPost` when aliased.
2. **VR-14 / VR-19** — Stabilize `RepostModal` focus effect; local repost draft state.
3. **VR-15** — Increment `repost_count` in API + client; wire UI counter.
4. **VR-17** — Pin scroll on comment vote (defer re-sort until navigation, or sort-stable keys).
5. **VR-16** — Isolate comment input re-renders; fix auto-resize scroll jump.
6. **VR-18** — E2E repro reply flow; fix API/UI nest if `parent_id` path broken.
7. **VR-3 / VR-4 / VR-5 / VR-6 / VR-7** — Consolidate reaction implementations.
8. **VR-2** — Show downvote count on detail actions (product call).
9. **VR-10** — Atomic RPC for comment likes (follow-up).

---

## Verification checklist (post-fix)

- [ ] `/post/[id]`: one upvote click → count +1 (logged in, cold load)
- [ ] `/post/[id]`: bookmark click → `like_count` unchanged; bookmark count +1 only
- [ ] `/post/[id]`: repost modal — type full sentence without flicker/focus loss
- [ ] `/post/[id]`: after repost → original post `repost_count` +1 (UI + DB)
- [ ] `/post/[id]`: type long comment — cursor stays in textarea
- [ ] `/post/[id]`: upvote comment mid-list — no scroll jump
- [ ] `/post/[id]`: reply to comment — nested under parent immediately + after refresh
- [ ] `/post/[id]`: toggle off upvote → count -1
- [ ] `/post/[id]`: downvote then upvote → swap counts correctly
- [ ] `/hot` modal + `/feed` modal: same behavior, no +2
- [ ] `/groups/[id]`: counts match GET `/api/posts/[id]` after like
- [ ] Hard refresh: count matches DB (exclude known bad seed posts)
- [ ] TC-POST-006 / TC-POST-007 in `docs/QA_TEST_CASES.md`
- [ ] `npm run test` — extend like/repost route tests + client tests for detail adapter

---

## Changelog

| Date | Action |
|------|--------|
| 2026-07-08 | Initial ledger: upvote/downvote bugs (VR-1–VR-12) |
| 2026-07-08 | Added bookmark/repost/comment/reply bugs (VR-13–VR-19) from user report — no code changes |
