# Post media lifecycle audit — 2026-08-03

Status: **migrations 1110 and 1120 GO on their inert scopes (P0=0/P1=0) / application cutover
NO-GO (one P1 open) / cleanup and GC disabled**. The repository now has fail-closed deletion guards,
an active upload-registration boundary, a private atomic claim substrate, and a private,
snapshot-only historical coverage inventory. No current app/API caller invokes either the claim or
coverage authorities, and neither substrate exposes cleanup-admission, lease, cron, GC,
lifecycle-delete, or Storage mutation authority. The media slice therefore has no currently known
P0; this audit covers the public `posts` Storage bucket only. Repository GO does not assert
production deployment, production inventory execution, or safe reclamation.

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

| Event                                                    | Current behavior                                                                                                                                                                  | Risk/status                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Image/video upload fails before verified acknowledgement | Upload errors leave the reservation for later lifecycle work; acknowledgement/list mismatch removes only the exact server-derived path                                            | Fail-closed; lifecycle cleanup remains P1                |
| Successful image/video upload                            | Dedicated routes reserve, upload, verify one exact acknowledgement/listing row plus object id, MIME, size, and optional content length, then finalize the same immutable identity | Registered with route-level metadata attestation         |
| Composer removes a selected image/video                  | Removes browser state/Markdown only                                                                                                                                               | P1 orphan; object remains                                |
| Composer is cancelled, tab closes, or draft is abandoned | The upload remains registered, but there is no claim/cleanup admission or worker that may act on its expiry                                                                       | P1 orphan                                                |
| Atomic post creation fails after one or more uploads     | Current APIs still call the legacy post RPC; migration 1110 provides an atomic create+claim wrapper, but it has zero callers                                                      | P1 cutover; current orphan behavior remains              |
| Post edit removes an image URL                           | Current APIs still call the legacy edit RPC; migration 1110 can record the exact final claim set but intentionally does not release removed claims                                | P1 cutover; current orphan behavior remains              |
| Group avatar submit/review                               | Current APIs still call legacy group authorities; migration 1110 can claim the application avatar and retain that claim while adding the approved group target                    | P1 cutover; historical coverage remains required         |
| Author hard-delete through `/api/posts/[id]/delete`      | Deletes only the database row; exact owner predicate/affected-row acknowledgement is enforced                                                                                     | P1 orphan; unsafe online cleanup is statically blocked   |
| Legacy hard-delete through `DELETE /api/posts/[id]`      | `lib/data/posts.ts` deletes only the database row; no internal client currently calls it                                                                                          | P1 compatibility surface                                 |
| Admin hard-delete through `/api/admin/moderate`          | Authenticated tombstone returns 410 and directs callers to atomic moderation/sanction endpoints; it performs no reads or writes                                                   | Retired; no media mutation surface                       |
| Group-admin moderation delete                            | Soft-deletes through `moderate_group_post_atomic`; row and media references remain                                                                                                | Retention is consistent with soft-delete/audit semantics |
| Account hard-delete                                      | Auth deletion does not remove posts; `posts.author_id` can become null                                                                                                            | Media remains referenced by retained posts               |

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
transaction. The leak must remain P1 until the atomic claim wrappers are cut over, historical media
is covered or quarantined, and a later durable cleanup outbox makes both orders safe.

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
- Finalize itself currently proves only bucket/name presence. Commit `d24d69a15` separately makes
  both service upload routes require exactly one matching Storage listing row with a non-empty
  object id, exact reserved MIME and size, and exact `contentLength` when Storage supplies it before
  finalization. A later atomic claim still has to revalidate durable registry/object identity rather
  than treating the route's earlier HTTP observation as a claim transaction.
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

Commit `b8dc3e1cb` originally placed 1100 exactly once in predeploy immediately after 1080. Commit
`741770650` places 1110 exactly once immediately after 1100, and commit `46ed38a07` places 1120
exactly once immediately after 1110. The current runner proof is 201 predeploy / 17 postdeploy / 228
unique classified migrations, with the Node contract still 19/19. The frozen runner SHA256 values
are `984bdf613aac8d637071a1368a6e7a61f76f45c675484075f7d57ed8c11a62f5` for the shell and
`a0f235adfa8ca89ae567b8b9832dcd5c96d31278526a5a63fbd3bfd4627254be` for its test. This is
repository evidence, not proof that production applied any media migration.

The migration's dedicated Jest proof is 13/13, and its disposable PostgreSQL 17 proof covers clean
install/replay, ACL and role-path drift, owner/path/MIME/expiry binding, privacy, and conflicting
concurrent reservations. The route/caller proofs cover reserve-before-Storage ordering, exact
finalization, explicit purposes, group-avatar CSRF, the closed generic bypass, stale/mismatched
receipts, commit/response ambiguity, and exact listing metadata. These are repository proofs; they
do not prove production deployment, live Storage behavior, claim ownership, or safe reclamation.

## Atomic claim substrate: migration 1110

Commit `de6c117e1` adds
`20260803111000_post_media_claims.sql` with SHA256
`4b87cae7dea0a2fb45693145482f1a8ff3bde05ecc75e0dc8c65db6171411dac`. The migration is an
additive, cleanup-inert predeploy contract:

- `post_media_claim_sets` records an exact operation/revision/manifest/result replay receipt, while
  `post_media_claims` retains upload-to-post, application, and approved-group reference evidence.
  Both tables are `postgres`-owned, private, FORCE-RLS relations with no policies or non-owner table
  or column authority. Neither table has a release/delete lifecycle transition.
- Four new service-only wrappers compose the existing post create/edit and group submit/review
  authorities. The internal manifest composer remains owner-only. Each wrapper calls the existing
  business authority before touching the claim ledger and returns that authority's exact JSON;
  claim failure raises in the same transaction and rolls the business write back.
- A post claim is bound to the database's exact final `content_version`. Group submit binds a
  pending application with no group; review binds the actual decision and target `group_id`.
  Approval retains the application claim and adds the group claim, including rolling-compatible
  applications submitted before 1110; rejection never creates a group claim.
- The caller manifest must exactly equal all canonical managed references in the stored final state.
  Every item must be an owner- and purpose-compatible `uploaded` row in `post_media_uploads` and
  have its exact `storage.objects(bucket_id = 'posts', name = object_name)` row. Missing, extra,
  foreign, stale-revision, malformed, unregistered, or already-GC-admitted evidence fails closed.
- Runtime lock order is business authority first, then sorted upload identities, C-sorted object
  names, registry/Storage rows, a locked target recheck, and finally claim rows. Exact operation
  replay is idempotent; conflicting replay fails. Migration replay also fails closed on partial
  publication, unexpected catalog/ACL/policy/trigger drift, unsafe role membership, or dependency
  authority drift.
- The migration does not release, unclaim, admit cleanup, lease work, create a cron/outbox, delete a
  row, or mutate Storage. Repository search confirms zero app/API callers, so scheduling 1110 does
  not switch live write paths or enable GC.

The dedicated static suite is 12/12 and the disposable PostgreSQL 17 adversarial proof passes,
including full JSON acknowledgement replay, rollback, exact manifest/Storage binding, stale
revision/group binding, catalog and authority drift, migration-vs-runtime exclusion, and real
multi-session contention. On that deliberately inert scope, the reviewed migration is **GO with
P0=0/P1=0**. These tests and commits do not prove production application or live-schema parity.

The TypeScript final-state collection and renderer grammar boundary is closed in code. Commit
`31b2e357a` rejects WHATWG-equivalent managed aliases; `001bdbdf2` aligns Markdown/raw tokenization
with the renderer; `35b514440` makes persisted video markers render and round-trip consistently;
and `f5c55e862` canonicalizes the video markers emitted by current creation callers. The combined
helper/renderer slice received an independent **P0=0/P1=0** review. This closes the former helper
P1; it does not switch the still-zero app/API callers to 1110.

Application/API cutover remains **NO-GO** on one historical coverage/cutover P1:

1. Execute 1120 in production, drain the legacy source writers, seal a new post-drain generation,
   and disposition every historical canonical post and group-avatar reference through exact
   backfill or explicit quarantine; only then move post and group callers to the corresponding 1110
   wrappers with exact acknowledgement validation. The app must not silently omit an unregistered
   historical reference merely to make a claim pass. The 1110 wrappers remain at zero app/API
   callers, and the separate historical worker/delete/GC boundary remains inactive.

## Historical coverage inventory: migration 1120

Commit `3c5d6e660` adds
`20260803112000_post_media_coverage_inventory.sql` with SHA256
`c2c437129fee69eb0f9b82c6956fd72463881e61cae98a4a20afc290022a761a`. It is a PREDEPLOY,
observe-only, snapshot-only historical inventory, not a cutover or GC gate:

- Exactly five `postgres`-owned private FORCE-RLS heap tables retain immutable configuration, run,
  target, attempt, and reference evidence. They expose no policies or non-owner table/column DML.
  Reference rows retain bounded hashes and lengths rather than attacker-controlled raw URL text.
- Exactly seven fixed-source, no-default SECURITY DEFINER functions are published. Origin
  installation and lexical classification remain owner-only; start, bounded enqueue, bounded
  observe, persistent seal, and scoped gate reads are service-only. Runtime functions use a five
  second lock timeout and a 30 second statement timeout.
- Nullable-start keysets enqueue at most 500 targets, observation locks at most 25 targets with
  `SKIP LOCKED`, and sealing folds immutable observed summaries through a persistent bounded keyset.
  Per-attempt evidence prevents a retry from overwriting the observation that justified an earlier
  classification.
- Observation reads post edits, group applications, approved group-avatar state, the 1100 upload
  registry, Storage object identity, and 1110 claim evidence under a reviewed lock order. It never
  writes a content, upload-registry, claim, or Storage row and never claims, releases, leases,
  admits, deletes, or garbage-collects media.
- The conservative `pg-lexical-v1` classifier accepts only the exact configured managed prefix,
  quarantines WHATWG-sensitive or over-2,048-byte spellings, and treats official direct Supabase
  hosts as noncanonical internal references rather than silently calling them external.
- A sealed run may report `snapshot_inventory_complete` and scope-local
  `snapshot_scope_complete`, but every gate response fixes `cutover_ready=false` and
  `authoritative_for_gc=false`, and reports `requires_new_generation_after_source_drain=true`.
  A snapshot can therefore describe historical coverage without becoming live-current authority.
- Repository search confirms zero app/API/cron callers and zero cleanup/GC authority. The migration
  is scheduled PREDEPLOY exactly once after 1110; production execution is still pending.

The dedicated static suite is 12/12 and the disposable PostgreSQL 17 hostile/replay/concurrency
proof passes. The frozen proof SHA256 values are
`63d824b632d30db098bfac4379a5dd61440dbb07d31601baca649a7b9868767e` for the Jest contract and
`0f3f5f6e3fb45a510d7ef949cf4a2a04b72d8ab21557dcbc1b3ed2d401e6efec` for the PG17 script. On
this deliberately inert scope, migration 1120 is **GO with P0=0/P1=0**. That verdict does not close
the remaining historical coverage/cutover P1.

Accepted P2 trust boundaries:

- The two 1100 upload authorities and all five new 1110 authorities are pinned to reviewed source
  bytes, but the four older composed content authorities
  (`create_post_atomic`, `edit_post_atomic`, `submit_group_application_atomic`, and
  `review_group_application_atomic`) retain their upstream comment plus `md5(current prosrc)`
  self-seal. This is limited to the declared trusted `postgres`/migration-management plane and does
  not grant a browser caller access; a later hardening migration can pin their reviewed source and
  default-expression metadata without blocking inert 1110.
- The 1120 classifier never guesses that a custom CNAME aliases the configured Storage authority.
  Only the exact configured prefix is managed; alternate CNAME spellings remain external or
  quarantined until an explicit reviewed alias contract exists.
- The 1120 scope gate computes scope-local aggregates under its 30 second safe statement timeout.
  A very large production generation may time out rather than return false readiness; later
  precomputation/index tuning may improve availability but must preserve that fail-closed truth.

## Why the registry and claim substrates are not lifecycle completion

The repository has a correct lease/ack cleanup model for private report evidence:
`report_evidence_uploads` plus `/api/cron/cleanup-report-evidence`. It is intentionally bound to the
private `reports` bucket and cannot safely be reused for public post objects.

A complete fix must extend `post_media_uploads` and the 1110 claim substrate, not add a client URL
deletion endpoint. Upload registration and the inert claim authority are complete in code; the
remaining lifecycle work is:

1. Apply the runner-scheduled 1120 through the governed channel and execute bounded historical
   inventory work in production.
2. Drain legacy source writers, start and seal a new 1120 generation, then backfill or quarantine
   every blocked historical canonical reference without inventing ownership or Storage evidence.
3. After the source-drained coverage evidence and disposition are complete, move all post and group
   callers to the corresponding 1110 wrappers and validate their exact acknowledgements.
4. Turn removed claims and deleted posts into cleanup-eligible rows; expire never-claimed uploads
   only through an auditable database transition.
5. Lease bounded rows to a cron worker, remove through the Storage API, then acknowledge or release
   the lease for retry.

Until the first three steps and their production proofs exist, app/API claim cutover must remain
disabled; until all five steps are complete, GC must remain disabled. Historical uploads do not
match a guaranteed registered lifecycle, so treating them as ordinary expired rows would be unsafe.
Migration 1110 creates safe, currently unreachable authority, and 1120 creates safe snapshot
evidence; neither by itself closes the remaining application-cutover P1 or authorizes reclamation.

## Executable verification

```sh
npx jest --runInBand --runTestsByPath \
  supabase/migrations/__tests__/post-media-upload-registry.test.ts
supabase/migrations/__tests__/post-media-upload-registry.pg17.sh

npx jest --runInBand --runTestsByPath \
  supabase/migrations/__tests__/post-media-claims.test.ts
supabase/migrations/__tests__/post-media-claims.pg17.sh

npx jest --runInBand --runTestsByPath \
  supabase/migrations/__tests__/post-media-coverage-inventory.test.ts
supabase/migrations/__tests__/post-media-coverage-inventory.pg17.sh

npx jest --runInBand --runTestsByPath \
  app/api/posts/upload-image/route.test.ts \
  app/api/posts/upload-video/route.test.ts \
  app/api/posts/__tests__/post-media-upload-purpose-callers.test.ts \
  app/api/upload/__tests__/route.test.ts \
  'app/(app)/groups/apply/__tests__/page.viewer-scope.test.tsx' \
  lib/posts/post-media-storage-evidence.test.ts \
  lib/posts/post-media-storage-path.test.ts \
  'app/api/posts/[id]/delete/__tests__/route.boundary.test.ts'
npx eslint --max-warnings=0 \
  app/api/posts/upload-image/route.ts \
  app/api/posts/upload-video/route.ts \
  lib/posts/post-media-upload-registry.ts \
  lib/posts/post-media-storage-evidence.ts \
  lib/posts/post-media-storage-path.ts \
  'app/api/posts/[id]/delete/route.ts'
npx tsc --noEmit
git diff --check
```

The tests enforce owner/path/origin/extension checks, bound attacker-controlled candidates, require
reserve/verify/finalize ordering and exact immutable receipts, reject alternate `posts` writers,
require group-avatar CSRF, preserve commit-ambiguous objects, bind atomic claim manifests to the
stored final state, retain bounded immutable snapshot evidence without mutating source/claim/Storage
rows, require the owner predicate and exact affected-row acknowledgement, ignore client media
fields, and keep a static no-Storage boundary on the production delete route.
