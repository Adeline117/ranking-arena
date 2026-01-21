# Refactor and Clean Code

Code refactoring expert specializing in clean code principles, SOLID design patterns, and modern software engineering best practices.

## Requirements

Refactor: **$ARGUMENTS**

## Code Analysis

### Code Smells Detection
- **Long Methods**: Functions > 50 lines
- **Large Classes**: Classes > 500 lines
- **Duplicate Code**: Repeated patterns
- **Dead Code**: Unreachable code paths
- **Complex Conditionals**: Deep nesting > 3 levels
- **Magic Numbers**: Unexplained literals
- **Poor Naming**: Unclear variable/function names
- **Tight Coupling**: Hard dependencies
- **Missing Abstractions**: Raw implementation details

### SOLID Violations
- **SRP**: Classes with multiple responsibilities
- **OCP**: Code requiring modification for extension
- **LSP**: Subtypes not substitutable
- **ISP**: Fat interfaces
- **DIP**: Depending on concretions

### Performance Issues
- Inefficient algorithms (O(n²) when O(n) possible)
- Unnecessary object creation
- Memory leaks
- Blocking operations
- Missing caching

## Refactoring Strategy

### Priority Levels
1. **Critical**: Security vulnerabilities, data corruption risks
2. **High**: Performance bottlenecks, maintainability blockers
3. **Medium**: Code smells, minor performance issues
4. **Low**: Style inconsistencies, nice-to-have improvements

### Techniques
- **Extract Method**: Break long functions
- **Extract Class**: Separate responsibilities
- **Inline**: Remove unnecessary indirection
- **Rename**: Improve clarity
- **Move**: Place code where it belongs
- **Replace Conditionals with Polymorphism**
- **Introduce Parameter Object**
- **Replace Magic Numbers with Constants**

## SOLID Principles Applied

### Single Responsibility
```typescript
// Before: Class does too much
class UserManager {
  createUser() { }
  sendEmail() { }
  generateReport() { }
}

// After: Separated concerns
class UserService { createUser() { } }
class EmailService { sendEmail() { } }
class ReportService { generateReport() { } }
```

### Open/Closed
```typescript
// Before: Requires modification
function calculateArea(shape) {
  if (shape.type === 'circle') return Math.PI * shape.radius ** 2;
  if (shape.type === 'square') return shape.side ** 2;
}

// After: Open for extension
interface Shape { calculateArea(): number; }
class Circle implements Shape { calculateArea() { return Math.PI * this.radius ** 2; } }
class Square implements Shape { calculateArea() { return this.side ** 2; } }
```

## Testing Strategy

- Write tests BEFORE refactoring
- Run tests after each change
- Maintain coverage throughout
- Add tests for newly extracted units

## Output

1. **Analysis Summary**: Key issues and their impact
2. **Refactoring Plan**: Prioritized changes with effort estimates
3. **Refactored Code**: Complete implementation
4. **Test Suite**: Tests for refactored components
5. **Metrics Report**: Before/after comparison

## Quality Checklist

- [ ] All methods < 20 lines
- [ ] Classes < 200 lines
- [ ] No method has > 3 parameters
- [ ] Cyclomatic complexity < 10
- [ ] No duplicate code blocks > 3 lines
- [ ] All tests passing
- [ ] Coverage maintained or improved
