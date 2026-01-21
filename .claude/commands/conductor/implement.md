# Implement Track

Execute tasks from a track's implementation plan following TDD workflow.

## Usage

```
/conductor:implement [track-id]
```

## Pre-flight Checks

1. Verify Conductor initialized
2. If missing: Display error and suggest running `/conductor:setup` first

## Track Selection

- If argument provided: Use specified track ID
- If no argument: Display menu of incomplete tracks organized by status

## Context Loading

Gather relevant documentation:
- Track spec and plan
- Product context
- Code style guides

## TDD Implementation Loop

For each task when TDD enabled:

### 1. Red Phase
- Write failing test
- Verify test fails for the right reason
- Commit: `test: add failing test for {task}`

### 2. Green Phase
- Implement minimal code to pass
- Run tests to verify green
- Commit: `feat: implement {task}`

### 3. Refactor Phase
- Clean up while keeping tests passing
- Commit: `refactor: improve {task}`

## Progress Management

Maintain detailed progress tracking in `metadata.json`:
- Current phase and task
- Completion percentages
- Generated commits

## Verification Checkpoints

After each phase:
1. Run full test suite
2. Verify no regressions
3. Wait for user approval before proceeding

## Critical Rules

- **NEVER** skip verification checkpoints
- **STOP** on any failure - do not attempt to continue
- Follow `workflow.md` strictly
- Keep task status accurate
- Commit frequently with tracking for potential reversions
