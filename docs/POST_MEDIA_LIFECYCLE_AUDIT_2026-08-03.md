# Post media lifecycle audit — 2026-08-03

Status: **P1 open / release NO-GO**, with fail-closed deletion guards and an active
upload-registration boundary. The media slice has no currently known P0 because it still exposes no
claim, cleanup-admission, lease, cron, GC, or lifecycle-delete authority; this audit covers the
public `posts` Storage bucket only.

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

Commit `05afdf4b1` makes every current caller explicit: post create/edit flows send `post_image`,
the group-application avatar flow sends `group_avatar`, and video is server-fixed to `post_video`;
the image route retains `legacy_image` only as its missing-field compatibility default. Commit
`468154b00` adds the required double-submit CSRF proof to the reachable group-avatar request.
Commit `e718f8477` removes `posts` from the generic `/api/upload` allowlist, closing the alternate
authenticated writer that could otherwise bypass the canonical UUID path and registry.

## Reachable lifecycle paths

| Event                                                    | Current behavior                                                                                                                       | Risk/status                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Image/video upload fails before verified acknowledgement | Upload errors leave the reservation for later lifecycle work; acknowledgement/list mismatch removes only the exact server-derived path | Fail-closed; lifecycle cleanup remains P1                |
| Successful image/video upload                            | Dedicated routes reserve, upload, verify the exact acknowledgement/listing, then finalize the same immutable identity                  | Registered; Storage metadata attestation remains P1      |
| Composer removes a selected image/video                  | Removes browser state/Markdown only                                                                                                    | P1 orphan; object remains                                |
| Composer is cancelled, tab closes, or draft is abandoned | The upload remains registered, but there is no claim/cleanup admission or worker that may act on its expiry                            | P1 orphan                                                |
| Atomic post creation fails after one or more uploads     | No claim/rollback link between upload and post RPC                                                                                     | P1 orphan                                                |
| Post edit removes an image URL                           | Atomic edit updates the database but has no storage claim transition                                                                   | P1 orphan                                                |
| Author hard-delete through `/api/posts/[id]/delete`      | Deletes only the database row; exact owner predicate/affected-row acknowledgement is enforced                                          | P1 orphan; unsafe online cleanup is statically blocked   |
| Legacy hard-delete through `DELETE /api/posts/[id]`      | `lib/data/posts.ts` deletes only the database row; no internal client currently calls it                                               | P1 compatibility surface                                 |
| Admin hard-delete through `/api/admin/moderate`          | Deletes only the database row                                                                                                          | P1 admin surface                                         |
| Group-admin moderation delete                            | Soft-deletes through `moderate_group_post_atomic`; row and media references remain                                                     | Retention is consistent with soft-delete/audit semantics |
| Account hard-delete                                      | Auth deletion does not remove posts; `posts.author_id` can become null                                                                 | Media remains referenced by retained posts               |

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

## Registry substrate and upload integration: migration 1100

Commit `05adf3ef3` adds
`20260803110000_post_media_upload_registry.sql` with SHA256
`61871a54eab1f4ffb6931d617ca5c517b60483d0fd98f425fd2f06cdc71f7bc1`. It is a deliberately
cleanup-inert predeploy foundation:

- `post_media_uploads` is private, owned by `postgres`, has forced RLS with no policies, and exposes
  no table/column DML authority to browser or service roles. `owner_id` intentionally has no foreign
  key or cascade that could erase lifecycle evidence during account deletion.
- The only published mutation authorities are service-only SECURITY DEFINER reserve and finalize
  functions. Reservation binds one immutable upload id to owner, object name, purpose, MIME, size,
  and a server-owned one-hour expiry. Canonical lowercase owner paths and exact MIME/extension pairs
  are enforced both at admission and by table constraints.
- Finalize locks the exact registry identity and requires an exact
  `storage.objects(bucket_id = 'posts', name = object_name)` row before changing `reserved` to
  `uploaded`. Replay is idempotent and conflicting upload/object identities are rejected under real
  concurrent sessions.
- Finalize currently proves only bucket/name presence. It does **not** attest the Storage object's
  actual metadata against the reserved MIME and size, so it is not yet sufficient claim evidence.
- Both statuses remain non-reclaimable lifecycle evidence (`reserved` or `uploaded`), and
  `gc_admitted_at` is constrained to remain `NULL`. The migration creates no claim, lease, cleanup,
  lifecycle delete, cron, outbox, or GC Storage mutation authority.

Commit `a7e493e4c` connects the dedicated image and video routes to that authority. Each request
creates a server upload id and canonical object path, reserves the exact owner/purpose/sniffed
MIME/size identity before touching Storage, requires the existing exact upload acknowledgement and
directory listing, and finalizes that same identity before returning the unchanged success JSON.
RPC data and HTTP status are treated as untrusted. A commit/response ambiguity gets one bounded
same-identity confirmation; if it remains ambiguous, the route fails closed and preserves the
tracked object. Only a complete PostgREST error carrying a PostgreSQL SQLSTATE and an HTTP 400–599
status proves rollback and permits best-effort removal of the server-generated exact path.
A reservation first-attempt replay is rejected before Storage; a finalization first-attempt replay
fails without deleting the tracked object.

Commit `b8dc3e1cb` places 1100 exactly once in predeploy immediately after 1080. The runner proof is
199 predeploy / 17 postdeploy / 226 unique classified migrations, with the Node contract still
19/19. This is repository evidence, not proof that production applied the migration.

The migration's dedicated Jest proof is 13/13, and its disposable PostgreSQL 17 proof covers clean
install/replay, ACL and role-path drift, owner/path/MIME/expiry binding, privacy, and conflicting
concurrent reservations. The route/caller proofs cover reserve-before-Storage ordering, exact
finalization, explicit purposes, group-avatar CSRF, the closed generic bypass, stale/mismatched
receipts, and commit/response ambiguity. These are repository proofs; they do not prove production
deployment, real Storage metadata equality, claim ownership, or safe reclamation.

## Why the registry substrate is not lifecycle completion

The repository has a correct lease/ack cleanup model for private report evidence:
`report_evidence_uploads` plus `/api/cron/cleanup-report-evidence`. It is intentionally bound to the
private `reports` bucket and cannot safely be reused for public post objects.

A complete fix must extend `post_media_uploads`, not add a client URL deletion endpoint. Upload
registration is complete in code; the remaining lifecycle work is:

1. Strengthen finalization so the stored object's real Storage metadata is attested against the
   reserved MIME and size, not merely bucket/name presence.
2. Claim uploaded rows inside the same database transaction as `create_post_atomic` and
   `edit_post_atomic`.
3. Quarantine or explicitly cover legacy object paths and include every non-post image consumer
   (group applications/groups) in claim ownership before enabling image cleanup.
4. Turn removed claims and deleted posts into cleanup-eligible rows; expire never-claimed uploads
   only through an auditable database transition.
5. Lease bounded rows to a cron worker, remove through the Storage API, then acknowledge or release
   the lease for retry.

Until all five steps and production proofs exist, claim/GC must remain disabled. Historical uploads
do not match a guaranteed registered lifecycle, so treating them as ordinary expired rows would be
unsafe. The remaining work crosses both atomic post mutations, group application approval,
generated database types, further migrations, and cron deployment; registered uploads alone do not
close P1.

## Executable verification

```sh
npx jest --runInBand --runTestsByPath \
  supabase/migrations/__tests__/post-media-upload-registry.test.ts
supabase/migrations/__tests__/post-media-upload-registry.pg17.sh

npx jest --runInBand --runTestsByPath \
  app/api/posts/upload-image/route.test.ts \
  app/api/posts/upload-video/route.test.ts \
  app/api/posts/__tests__/post-media-upload-purpose-callers.test.ts \
  app/api/upload/__tests__/route.test.ts \
  'app/(app)/groups/apply/__tests__/page.viewer-scope.test.tsx' \
  lib/posts/post-media-storage-path.test.ts \
  'app/api/posts/[id]/delete/__tests__/route.boundary.test.ts'
npx eslint --max-warnings=0 \
  app/api/posts/upload-image/route.ts \
  app/api/posts/upload-video/route.ts \
  lib/posts/post-media-upload-registry.ts \
  lib/posts/post-media-storage-path.ts \
  'app/api/posts/[id]/delete/route.ts'
npx tsc --noEmit
git diff --check
```

The tests enforce owner/path/origin/extension checks, bound attacker-controlled candidates, require
reserve/verify/finalize ordering and exact immutable receipts, reject alternate `posts` writers,
require group-avatar CSRF, preserve commit-ambiguous objects, require the owner predicate and exact
affected-row acknowledgement, ignore client media fields, and keep a static no-Storage boundary on
the production delete route.
