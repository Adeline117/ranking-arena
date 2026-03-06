Read the spec file at `$ARGUMENTS`.

Follow this process:

1. Read the spec file completely. Understand the requirements and acceptance criteria.
2. Read CLAUDE.md for project conventions.
3. Create a feature branch: `git checkout -b feature/<spec-name>`
4. Implement each acceptance criterion one at a time:
   a. Write the code for that criterion
   b. Verify it works (run relevant tests, type-check)
   c. Commit with a descriptive message
   d. Move to the next criterion
5. After all criteria are met:
   a. Run `npm run type-check`
   b. Run `npm test`
   c. Run `npm run build`
   d. If all pass, push the branch
6. Update PROGRESS.md with what was completed.

Rules:
- Do NOT ask questions. Make reasonable decisions based on existing patterns in the codebase.
- If stuck on a criterion for more than 3 attempts, skip it, note it in the commit message, and continue.
- Each commit should be atomic and pass type-check on its own.
- Follow existing code patterns (check similar files in the codebase first).
