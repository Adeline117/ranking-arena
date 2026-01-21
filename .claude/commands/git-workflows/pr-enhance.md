# PR Enhancement - Pull Request Optimization

Create high-quality pull requests that facilitate efficient code reviews with comprehensive descriptions, proper documentation, and test coverage analysis.

## Requirements

Enhance PR for: **$ARGUMENTS**

## PR Analysis

### Change Summary Generator
- Categorize files by type (source, test, config, docs, styles, build)
- Calculate statistics (insertions, deletions, affected files)
- Identify high-risk changes

### Review Checklist Generation
Create context-aware checklists:

**Code Quality**
- [ ] No console.log/debug statements
- [ ] No commented-out code
- [ ] Functions < 50 lines
- [ ] Proper error handling

**Testing**
- [ ] Unit tests for new functionality
- [ ] Integration tests if needed
- [ ] Edge cases covered

**Security**
- [ ] No hardcoded secrets
- [ ] Input validation
- [ ] Authentication checks

## PR Description Template

```markdown
## Summary
[1-3 sentences describing the change]

## What Changed
- [Change 1]
- [Change 2]

## Why
[Business context and motivation]

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Screenshots (if applicable)
[Before/After images]

## Performance Impact
[Any performance considerations]

## Breaking Changes
[Migration steps if needed]
```

## Risk Assessment

Calculate PR risk across dimensions:
- **Size**: Lines changed, files affected
- **Complexity**: Cyclomatic complexity delta
- **Test Coverage**: Coverage change %
- **Dependencies**: External dependency changes
- **Security**: Security-sensitive code touched

Risk levels: LOW | MEDIUM | HIGH | CRITICAL

## Size Optimization

For large PRs (>500 lines):
- Suggest logical splits
- Identify independent changes
- Recommend stacked PRs

## Code Review Automation

Auto-detect common issues:
- Console statements
- Large functions
- Missing error handling
- TODO comments
- Hardcoded values

## Output

1. **PR Summary**: Executive summary with key metrics
2. **Detailed Description**: Comprehensive PR description
3. **Review Checklist**: Context-aware review items
4. **Risk Assessment**: Risk analysis with mitigation
5. **Test Coverage**: Before/after comparison
6. **Size Recommendations**: Splitting suggestions if needed
