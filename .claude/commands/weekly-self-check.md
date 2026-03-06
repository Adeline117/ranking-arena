Perform the weekly Arena self-improvement analysis. Follow these steps exactly:

## 1. Analyze Pipeline Health (last 7 days)

Query the `pipeline_logs` table (or use `pipeline_job_stats` view) to find:
- Jobs with the lowest success rates
- Most frequent error messages
- Jobs that have been consistently slow (avg_duration_ms trending up)
- Any jobs that haven't run at all

## 2. Analyze Data Anomalies

Query `trader_anomalies` for the past week:
- Most common anomaly types
- Platforms with the most anomalies
- Any patterns (e.g., same field failing across platforms)

## 3. Check Code Quality

Run these checks:
- `npm run type-check` - any new type errors?
- Look at recent git commits for any reverted fixes (indicates recurring issues)
- Check if any TODO/FIXME comments are more than 2 weeks old

## 4. Generate Improvement Report

Write findings to `/docs/IMPROVEMENTS.md` with this structure:

```markdown
# Weekly Improvement Report - [Date]

## Pipeline Issues
- [Issue 1]: [Suggested fix]
- [Issue 2]: [Suggested fix]

## Data Quality Issues
- [Pattern]: [Root cause] -> [Fix]

## Code Quality
- [Finding]: [Action needed]

## Auto-implemented (Low Risk)
- [What was changed and why]

## Needs Confirmation (High Risk)
- [Proposed change] - [Why it's risky]
```

## 5. Auto-Fix Low-Risk Issues

If you find issues that are:
- Clearly bugs (not feature changes)
- Only affect error handling or logging
- Don't change business logic
- Affect fewer than 3 files

Then fix them immediately, commit, and note in the report.

## 6. Flag High-Risk Issues

For anything that:
- Changes core logic (Arena Score, data ingestion, payment)
- Requires migration changes
- Affects more than 5 files

Do NOT fix. Document in the report under "Needs Confirmation".

## 7. Update PROGRESS.md

Add a note about this self-check run.
