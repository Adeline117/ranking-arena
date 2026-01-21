# GitHub Issue Resolution

Systematic bug investigation, feature implementation, and collaborative development workflows.

## Requirements

Resolve issue: **$ARGUMENTS**

## Issue Analysis

### Initial Investigation
1. Get complete issue details from GitHub
2. Check metadata (labels, assignees, milestone)
3. Review linked PRs and related issues

### Priority Classification
- **P0/Critical**: Production down, data loss, security breach
- **P1/High**: Major functionality broken, significant user impact
- **P2/Medium**: Important feature/fix, moderate impact
- **P3/Low**: Minor improvement, low priority

## Investigation Process

### Code Archaeology
```bash
# Find when bug was introduced
git bisect start
git bisect bad HEAD
git bisect good v1.0.0

# Blame analysis
git blame -L 100,120 src/component.ts
```

### Root Cause Analysis
1. Reproduce the issue
2. Identify affected code paths
3. Trace error propagation
4. Document contributing factors

## Branch Strategy

### Naming Conventions
- `feature/issue-{NUMBER}-description`
- `fix/issue-{NUMBER}-component-bug`
- `hotfix/issue-{NUMBER}-critical-fix`
- `spike/issue-{NUMBER}-investigation`

## Implementation

### Task Breakdown
```markdown
## Phase 1: Foundation
- [ ] Set up test fixtures
- [ ] Create failing test for bug

## Phase 2: Core Fix
- [ ] Implement fix
- [ ] Verify tests pass

## Phase 3: Integration
- [ ] Update related components
- [ ] Integration tests

## Phase 4: Polish
- [ ] Documentation
- [ ] Code review
```

### Test-Driven Development
```typescript
// 1. Write failing test
describe('buggy function', () => {
  it('should handle edge case', () => {
    expect(buggyFunction(edgeCase)).toBe(expectedResult);
  });
});

// 2. Implement fix
function buggyFunction(input) {
  // Fixed implementation
}

// 3. Verify and refactor
```

## Pull Request Creation

### PR Template
```markdown
## Summary
Fixes #{ISSUE_NUMBER}

## Changes Made
- [Change 1]
- [Change 2]

## Testing
- [x] Unit tests added
- [x] Integration tests pass
- [x] Manual testing completed

## Checklist
- [x] Tests pass
- [x] No console.log statements
- [x] Documentation updated
```

### GitHub CLI
```bash
gh pr create \
  --title "fix: resolve issue #123" \
  --body "$(cat pr-description.md)" \
  --assignee @me \
  --label "bug"
```

## Post-Implementation

### Verification
1. Deploy to staging
2. Verify fix works
3. Monitor for regressions

### Issue Closure
```bash
gh issue close 123 --comment "Fixed in #456"
```

## Output

1. **Resolution Summary**: Root cause and fix explanation
2. **Code Changes**: Links to modified files
3. **Test Results**: Coverage report
4. **Pull Request**: URL to created PR
5. **Verification Steps**: QA instructions
