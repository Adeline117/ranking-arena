# New Track

Create a new track (feature, bug fix, chore, or refactor) with detailed specification and phased implementation plan.

## Usage

```
/conductor:new-track <feature|bug|chore|refactor> <name>
```

## Pre-flight Checks

1. Verify Conductor is initialized
2. Load context files for product, technical, and TDD/commit preferences

## Track Classification

- **Feature**: New functionality
- **Bug**: Fix for existing issue
- **Chore**: Maintenance task
- **Refactor**: Code improvement without behavior change

## Interactive Specification Gathering

**CRITICAL RULES:**
- Ask ONE question per turn
- Wait for user response before proceeding
- Tailor questions based on track type
- Maximum 6 questions total

### For Feature Tracks
1. Feature Summary
2. User Story
3. Acceptance Criteria
4. Dependencies
5. Scope Boundaries
6. Technical Considerations

### For Bug Tracks
1. Bug Summary
2. Steps to Reproduce
3. Expected vs Actual Behavior
4. Affected Areas
5. Root Cause Hypothesis

### For Chore/Refactor Tracks
1. Task Summary
2. Motivation
3. Success Criteria
4. Risk Assessment

## Track ID Generation

Format: `{shortname}_{YYYYMMDD}`
Example: `user-auth_20250115`

Validate uniqueness in `conductor/tracks.md`

## Specification Generation

Create `conductor/tracks/{trackId}/spec.md`:
- Track ID, Type, Created date, Status
- Summary and Context
- User Story
- Acceptance Criteria
- Dependencies
- Out of Scope
- Technical Notes

## Plan Generation

Create `conductor/tracks/{trackId}/plan.md` with phased implementation:

- **Phase 1**: Setup/Foundation
- **Phase 2**: Core Implementation
- **Phase 3**: Integration
- **Phase 4**: Polish

Each phase includes Tasks and Verification steps.

## Track Registration

1. Create directory structure with spec.md, plan.md, metadata.json
2. Register in `conductor/tracks.md`
3. Update `conductor/index.md`
