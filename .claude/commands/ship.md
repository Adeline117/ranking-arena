---
description: Release manager — merge base, test, bump version, CHANGELOG, create PR
---

Read `.claude/skills/arena-ship/SKILL.md` and execute the full ship workflow.

Pre-flight: verify we're on a feature branch (not main).
Then: merge base → run tests → review diff → bump version → update CHANGELOG → commit → push → create PR.

If any step fails, STOP and report the failure. Do not skip steps.
