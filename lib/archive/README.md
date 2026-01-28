# Archived Code

This directory contains code that was developed but is not currently integrated into the application. The code is valuable and may be integrated in the future, but is archived to reduce codebase complexity.

## Archived Files

### anomaly-detection.ts
**Date Archived**: 2026-01-28
**Reason**: Advanced anomaly detection algorithms (489 lines) that are not currently used in the application. This includes:
- Statistical anomaly detection (z-score, IQR)
- Machine learning-based detection (Isolation Forest)
- Trader behavior pattern analysis
- Multi-dimensional anomaly scoring

**Future Integration**: Could be valuable for:
- Detecting suspicious trader behavior
- Identifying data quality issues
- Flagging unusual trading patterns for review
- Building trust scores for traders

### smart-scheduler.ts
**Date Archived**: 2026-01-28
**Reason**: Intelligent scheduling system (239 lines) for dynamic refresh rate adjustment. Currently using simpler cron-based scheduling. Features include:
- Activity-based tier classification (hot/active/normal/dormant)
- Dynamic interval adjustment based on trader activity
- Batch scheduling optimization
- Historical activity tracking

**Future Integration**: Could be valuable for:
- Optimizing API call rates to exchanges
- Reducing costs by updating dormant traders less frequently
- Prioritizing hot traders for real-time updates
- Improving overall system efficiency

## Restoration Guide

To restore any of these files:

1. Move the file back to its original location
2. Check for any dependency updates needed
3. Add tests for the functionality
4. Update documentation
5. Integrate into the appropriate service/component

## Notes

- All archived code passed type checking at time of archival
- Code follows project style guidelines
- No external dependencies were removed (still in package.json if needed)
- Original file paths preserved in git history
