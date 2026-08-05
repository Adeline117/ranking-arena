# Documentation Policy

**Owner:** Repository CODEOWNERS

**Last verified:** 2026-08-04

Documentation is part of the production contract. A change is incomplete when
its supported command, ownership boundary, failure mode, or rollback path is
different from the checked-in documentation.

## Lifecycle catalog

`docs/README.md` is the single lifecycle catalog for tracked Markdown under
`docs/`. Every tracked document except the catalog itself appears exactly once
under one of these classes:

- **Current guidance:** supported onboarding, architecture, policy, reference,
  security, quality, deployment, and recovery material. Update it in the same
  pull request as the behavior it describes.
- **Active plans and decision queues:** unfinished execution plans, external
  gates, or owner choices. A plan does not authorize production access,
  deployment, migration, credential rotation, spending, or destructive work.
- **Historical evidence:** point-in-time audits, retrospectives, incident
  records, completed investigations, and superseded designs. Revalidate these
  against current guidance before use; an unchecked historical task is not
  automatically the current backlog.

Every lifecycle-catalog classification entry uses an inline destination. Do not
use reference-style links for catalog entries; the per-entry classifier must be
able to bind each destination to the section containing that line.

Architecture decisions remain append-only in `docs/DECISIONS.md`. Mark an old
ADR `Superseded` and link its replacement instead of silently rewriting history.
New or materially updated point-in-time documents include a date, explicit
status, owner or decision-maker, and any remaining gate.

## Authoring contract

1. Reference only tracked repository paths and commands that work from the
   repository root. Use relative links for repository files.
2. Use the governed repository-link forms: links and images with inline
   destinations containing balanced or escaped parentheses, or full, collapsed,
   and shortcut references backed by a single-line definition. Put paths
   containing spaces in `<angle brackets>`. Other CommonMark link forms are
   outside this contract; extend the parser and its fixtures before adopting
   them for repository paths.
3. Name one authoritative owner for each deployable, scheduler, queue, data
   writer, and recovery path. Do not document two paths as production owners.
4. Describe degraded behavior conservatively. A cache or retry is not a recovery
   guarantee, and load-bearing coordination must never be called fail-open.
5. Use placeholders for credentials and tokens. Do not copy secret values,
   credential-bearing URLs, logs, or local environment files into documentation.
6. State prerequisites and rollback evidence before destructive, production,
   database, queue, or keyspace operations. Prefer fail-closed instructions.
7. Update the document's verification date when its commands and runtime claims
   are materially revalidated.
8. Add, rename, or move a Markdown document only when the same change updates
   the lifecycle catalog and every inbound repository link.

## Archive and deletion gate

An old date, zero inbound links, or a completed checkbox is not enough evidence
to delete a document. Before moving or deleting one:

1. Search code, configuration, automation, and documentation for inbound
   references and update every active reference in the same change.
2. Confirm that a current authority replaces any supported instruction, and
   preserve a supersession pointer when a stable path is already widely used.
3. Resolve or explicitly transfer every open production, migration, security,
   incident, credential, budget, and owner-decision item. These require owner
   disposition; do not infer closure from age.
4. Preserve incident evidence, ADR history, and legally or operationally useful
   audit trails. Prefer an explicit historical classification over moving a
   stable path solely for cosmetic directory symmetry.
5. Delete only material that is demonstrably duplicated, generated and
   reproducible, or superseded with no remaining evidence value. Git history is
   a recovery aid, not the only retention plan for operational evidence.

## Review and automation

- CODEOWNERS defines the minimum reviewer for high-risk documentation.
- `scripts/qa/documentation-links.mjs` discovers tracked `.md` and `.markdown`
  documentation case-insensitively. Its dedicated contract test covers the
  supported inline, reference-style, image, and linked-image parser.
- Link-like examples are ignored only inside backtick code spans or top-level
  fenced code blocks whose opening and closing fences have at most three leading
  spaces. Container-nested list or blockquote fences are outside the supported
  subset; link-like text inside them is checked as documentation until parser
  support and fixtures are added.
- For every supported relative repository target, the link helper fails closed
  on invalid encoding, lexical or realpath escape, a symlink in any ancestor or
  final path component, missing paths, untracked files, and directories without
  a tracked descendant. URI-scheme, fragment-only, and root-relative product
  links are outside the repository-path check.
- `scripts/qa/repository-governance-contract.test.mjs` applies that helper to
  every tracked documentation page and requires exactly one lifecycle
  classification per page.
- The contract deliberately contains no fixed document count: adding or
  removing a tracked page changes the discovered set and therefore requires a
  matching catalog update.
- Automation proves classification and path integrity only. Reviewers remain
  responsible for semantic freshness, operational safety, retention, and owner
  disposition.
