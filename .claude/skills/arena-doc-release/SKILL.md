---
name: arena-doc-release
description: Post-ship documentation update. Reads all docs, cross-references diff, updates README/CLAUDE.md/CHANGELOG/PROGRESS.md to match what shipped.
---

# Arena Document Release

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy.

Post-ship documentation sync. Ensures all project docs accurately reflect what was just shipped.

## When to Use
Run this after `/ship` or after any significant merge to main.

## Process

### Step 1: Identify What Changed
```bash
# Get the diff of what was just shipped
# Option A: Compare with previous tag
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~10")..HEAD

# Option B: Recent commits on main
git log --oneline -20 --no-merges
```

Categorize changes:
- New features
- Bug fixes
- Architecture changes
- New API routes
- New/modified cron jobs
- Database changes
- New dependencies
- Configuration changes

### Step 2: Read All Project Docs
Read these files and note any discrepancies:
- `README.md`
- `CLAUDE.md`
- `PROGRESS.md`
- `TASKS.md`
- `CHANGELOG.md`
- `docs/DESIGN.md` (if exists)
- `docs/ARCHITECTURE.md` (if exists)
- `vercel.json` (cron jobs list)
- `package.json` (version, scripts, deps)

### Step 3: Update Each Document

#### CLAUDE.md Updates
- Update "Directory Structure" if new top-level dirs added
- Update "Key Commands" if new npm scripts
- Update "Database Schema" if new tables
- Update "Data Pipeline" if cron jobs changed
- Update "Exchange Connectors" if new connectors
- Update "Known Issues" if issues resolved or new ones found
- Update "Quick Reference" table

#### PROGRESS.md Updates
- Move completed items to "Recently Completed"
- Update "Current Sprint Focus"
- Archive items older than 2 weeks

#### TASKS.md Updates
- Mark completed tasks as done
- Remove tasks that are no longer relevant
- Add new tasks discovered during the ship

#### CHANGELOG.md Updates
- Ensure all changes from this release are documented
- Format follows Keep a Changelog standard
- Version number matches package.json

#### README.md Updates
- Update feature list if new features shipped
- Update tech stack if new dependencies
- Update setup instructions if configuration changed

### Step 4: Clean Up TODOs
```bash
# Find resolved TODOs
grep -rn "TODO\|FIXME" app/ lib/ --include="*.ts" --include="*.tsx"
```

For each TODO:
- If the code around it was changed and the TODO is resolved → remove it
- If the TODO references a completed task → remove it
- If still valid → leave it

### Step 5: Memory Update
Check if any changes affect the memory system:
- New architecture decisions → update relevant memory files
- New infrastructure → update VPS/pipeline memories
- Changed conventions → update feedback memories

### Step 6: Commit

```bash
git add CLAUDE.md PROGRESS.md TASKS.md CHANGELOG.md README.md docs/
git commit -m "docs: post-ship documentation sync

Updated docs to reflect recent changes:
- [list of doc updates]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Step 7: Output Summary

```markdown
# Documentation Release — [Date]

## Documents Updated
- [x] CLAUDE.md: [what changed]
- [x] PROGRESS.md: [what changed]
- [ ] TASKS.md: no changes needed
- [x] CHANGELOG.md: [version]

## TODOs Cleaned
- Removed [N] resolved TODOs
- [N] TODOs remaining

## Discrepancies Found
- [doc] said [X] but code shows [Y] — fixed

## Suggested Follow-ups
- [any documentation gaps that need user input]
```

## Rules
- NEVER change code — documentation only
- NEVER fabricate features or changes — only document what actually shipped
- Keep docs concise — Arena values brevity
- Match existing tone and format of each document
- If unsure about a change, flag it as "Suggested Follow-up" rather than guessing
