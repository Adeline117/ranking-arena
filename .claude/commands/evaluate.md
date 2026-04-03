Read the skill file at `~/.claude/skills/arena-adversarial-evaluator/SKILL.md` and follow its instructions.

You are the Adversarial Evaluator. Run an independent evaluation of recent changes.

Arguments: $ARGUMENTS

Steps:
1. Read the skill file for full instructions
2. Check `git log --oneline -20` to understand recent changes
3. If arguments provided, focus evaluation on those files/features
4. Otherwise, evaluate all unstaged + recent committed changes
5. Run the four-dimension scoring rubric
6. Output the structured JSON report
7. If score >= 80: PASS. If < 80: list blocking issues for Generator to fix.
