# Post media lifecycle audit — 2026-08-03

Status: P1 open, with fail-closed deletion guards. This audit covers the public `posts` Storage
bucket only.

## Object and ownership contract

| Media | Server-created object path                                         | Maximum upload | Durable post reference                                             |
| ----- | ------------------------------------------------------------------ | -------------: | ------------------------------------------------------------------ |
| Image | `<auth user UUID>/<object UUID>.(jpg\|png\|gif\|webp\|avif)`       |          5 MiB | `posts.images text[]` and, optionally, Markdown in `posts.content` |
| Video | `<auth user UUID>/videos/<object UUID>.(mp4\|mov\|webm\|mkv\|avi)` |        100 MiB | Markdown URL in `posts.content`                                    |

Both upload routes derive the first path segment from the authenticated server identity. The
`userId` form field is not authoritative. Clients now accept only exact acknowledgements through
`lib/posts/post-media-upload-contract.ts`.

The same image namespace is also used by the group-application avatar flow. Therefore, deleting an
author directory or treating every image not found in `posts.images` as an orphan would delete live
group avatars.

## Reachable lifecycle paths

| Event                                                    | Current behavior                                                                                   | Risk/status                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Image/video upload fails before verified acknowledgement | Upload routes remove the exact server-derived path after acknowledgement/list verification failure | Covered                                                  |
| Composer removes a selected image/video                  | Removes browser state/Markdown only                                                                | P1 orphan; object remains                                |
| Composer is cancelled, tab closes, or draft is abandoned | No server cleanup registration or TTL                                                              | P1 orphan                                                |
| Atomic post creation fails after one or more uploads     | No claim/rollback link between upload and post RPC                                                 | P1 orphan                                                |
| Post edit removes an image URL                           | Atomic edit updates the database but has no storage claim transition                               | P1 orphan                                                |
| Author hard-delete through `/api/posts/[id]/delete`      | Deletes only the database row; exact owner predicate/affected-row acknowledgement is enforced      | P1 orphan; unsafe online cleanup is statically blocked   |
| Legacy hard-delete through `DELETE /api/posts/[id]`      | `lib/data/posts.ts` deletes only the database row; no internal client currently calls it           | P1 compatibility surface                                 |
| Admin hard-delete through `/api/admin/moderate`          | Deletes only the database row                                                                      | P1 admin surface                                         |
| Group-admin moderation delete                            | Soft-deletes through `moderate_group_post_atomic`; row and media references remain                 | Retention is consistent with soft-delete/audit semantics |
| Account hard-delete                                      | Auth deletion does not remove posts; `posts.author_id` can become null                             | Media remains referenced by retained posts               |

## Fail-closed hard-delete boundary

The primary author delete route now strengthens its database deletion without attempting Storage
cleanup:

1. Read `author_id` from the database and require `author_id === authenticated user.id`.
2. Delete with both `id` and `author_id` predicates.
3. Request `RETURNING id` and accept exactly one affected row. A zero-row, null, object-shaped, or
   multi-row acknowledgement fails closed instead of reporting a false success.
4. Do not read request JSON/form data/query media values and do not access Storage.

The fourth rule is an executable static guard. It prevents an apparently simple cleanup endpoint
from trusting a client URL/path or deleting Storage directly before the registry lifecycle exists.

An attempted "delete row, query for remaining URL references, then remove object" design was
explicitly rejected because it has this P0-producing race:

1. Delete A commits and a cleanup query observes no remaining reference.
2. Concurrent create/edit B commits the same URL after that query.
3. Cleanup removes the object and leaves live post B permanently broken.

Checking references before deleting the post is also unsafe: a database delete failure would leave
the live post pointing at an already removed object. Database and Storage operations cannot share a
transaction. The leak must remain P1 until a claim registry and durable cleanup outbox make both
orders safe.

`lib/posts/post-media-storage-path.ts` supplies strict future-worker parsing only; production delete
routes do not call it. It accepts the configured origin and the exact lowercase current-owner
`<owner>/videos/<UUID>.<allowed extension>` path, rejects image/foreign/query/credential/encoded
paths, deduplicates candidates, and bounds scans to eight objects.

## Why the remaining cleanup needs a registry

The repository has a correct lease/ack cleanup model for private report evidence:
`report_evidence_uploads` plus `/api/cron/cleanup-report-evidence`. It is intentionally bound to the
private `reports` bucket and cannot safely be reused for public post objects.

A complete fix requires a new `post_media_uploads` lifecycle, not a client URL deletion endpoint:

1. Reserve an owner-bound object row before upload and finalize it only after Storage confirms the
   exact server-derived path.
2. Claim uploaded rows inside the same database transaction as `create_post_atomic` and
   `edit_post_atomic`.
3. Turn removed claims and deleted posts into cleanup-eligible rows; expire never-claimed uploads
   after a short TTL.
4. Lease bounded rows to a cron worker, remove through the Storage API, then acknowledge or release
   the lease for retry.
5. Include the non-post image consumers (group applications/groups) in claim ownership before
   enabling image cleanup.

This crosses upload routes, both atomic post mutations, group application approval, a migration,
generated database types, and cron deployment. It should be delivered as a dedicated migration
series rather than folded into the in-flight post-edit facet migration.

## Executable verification

```sh
npx jest --runInBand --runTestsByPath \
  lib/posts/post-media-storage-path.test.ts \
  'app/api/posts/[id]/delete/__tests__/route.boundary.test.ts'
npx eslint --max-warnings=0 \
  lib/posts/post-media-storage-path.ts \
  'app/api/posts/[id]/delete/route.ts'
npx tsc --noEmit
git diff --check
```

The tests enforce owner/path/origin/extension checks, bound attacker-controlled candidates, require
the owner predicate and exact affected-row acknowledgement, ignore client media fields, and keep a
static no-Storage boundary on the production delete route.
