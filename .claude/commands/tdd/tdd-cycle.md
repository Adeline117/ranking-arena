# TDD Cycle - Test-Driven Development Workflow

Execute a comprehensive Test-Driven Development (TDD) workflow with strict red-green-refactor discipline.

## Configuration

### Coverage Thresholds
- Minimum line coverage: 80%
- Minimum branch coverage: 75%
- Critical path coverage: 100%

### Refactoring Triggers
- Cyclomatic complexity > 10
- Method length > 20 lines
- Class length > 200 lines
- Duplicate code blocks > 3 lines

## Phase 1: Test Specification and Design

### Requirements Analysis
- Analyze feature requirements: $ARGUMENTS
- Create test specification with acceptance criteria
- Build edge case matrix for comprehensive coverage

### Test Architecture Design
- Design test fixtures and mock strategy
- Plan test organization and naming conventions

## Phase 2: RED - Write Failing Tests

### Write Unit Tests (Failing)
- Write tests BEFORE implementation
- **CRITICAL**: Verify all tests fail with expected error messages
- Tests must fail for the RIGHT reasons (not syntax errors)

### Verify Test Failure
- **GATE**: Do not proceed until all tests fail appropriately

## Phase 3: GREEN - Make Tests Pass

### Minimal Implementation
- Write the MINIMUM code needed to pass tests
- No extra features or optimizations yet
- Focus only on making tests green

### Verify Test Success
- **GATE**: All tests must pass before proceeding

## Phase 4: REFACTOR - Improve Code Quality

### Code Refactoring
- Apply SOLID principles
- Remove duplication
- Improve naming and readability
- **Constraint**: Tests must remain green throughout

### Test Refactoring
- Remove test duplication
- Improve test names and documentation
- Extract common fixtures

## Validation Checkpoints

### RED Phase
- [ ] All tests written before implementation
- [ ] All tests fail with meaningful error messages
- [ ] Test failures are due to missing implementation

### GREEN Phase
- [ ] All tests pass
- [ ] No extra code beyond test requirements
- [ ] Coverage meets minimum thresholds

### REFACTOR Phase
- [ ] All tests still pass after refactoring
- [ ] Code complexity reduced
- [ ] Duplication eliminated

## Success Criteria

- 100% of code written test-first
- All tests pass continuously
- Coverage exceeds thresholds
- Code complexity within limits
- Fast test execution (< 5 seconds for unit tests)

## Notes

- Enforce strict RED-GREEN-REFACTOR discipline
- Each phase must be completed before moving to next
- Tests are the specification
- If a test is hard to write, the design needs improvement
- Refactoring is NOT optional
