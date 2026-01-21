# Test Generation - Automated Unit Test Creation

Generate comprehensive, maintainable unit tests across multiple languages and frameworks.

## Requirements

Generate tests for: **$ARGUMENTS**

## Analysis Process

1. **Code Scanning**: Identify untested functions and classes
2. **Complexity Assessment**: Calculate cyclomatic complexity
3. **Test Scenario Generation**: Determine test cases needed
4. **Mock Identification**: Identify dependencies to mock

## Test Categories

### Happy Path Tests
- Normal input produces expected output
- Standard use cases covered

### Edge Case Tests
- Empty/null inputs
- Boundary values (min/max)
- Single element collections
- Unicode and special characters

### Error Handling Tests
- Invalid inputs rejected
- Exceptions thrown correctly
- Error messages are helpful

### Integration Points
- External service calls mocked
- Database operations verified
- API contracts tested

## Framework-Specific Patterns

### Python (pytest)
```python
import pytest
from unittest.mock import Mock, patch

class TestClassName:
    @pytest.fixture
    def setup(self):
        return TargetClass()

    def test_should_do_x_when_y(self, setup):
        # Arrange
        input_data = create_test_data()

        # Act
        result = setup.method(input_data)

        # Assert
        assert result == expected

    def test_should_raise_when_invalid(self, setup):
        with pytest.raises(ValueError):
            setup.method(invalid_input)
```

### JavaScript (Jest)
```javascript
describe('ClassName', () => {
  let instance;

  beforeEach(() => {
    instance = new ClassName();
  });

  describe('methodName', () => {
    it('should do X when Y', () => {
      // Arrange
      const input = createTestData();

      // Act
      const result = instance.method(input);

      // Assert
      expect(result).toEqual(expected);
    });

    it('should throw when invalid', () => {
      expect(() => instance.method(invalid))
        .toThrow(Error);
    });
  });
});
```

### React Components
```javascript
import { render, fireEvent, screen } from '@testing-library/react';

describe('Component', () => {
  it('should render without crashing', () => {
    render(<Component />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('should handle user interaction', () => {
    const onClick = jest.fn();
    render(<Component onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

## Coverage Analysis

- Identify uncovered lines and branches
- Find files below 80% threshold
- Generate targeted tests for gaps

## Output

1. **Test Files**: Complete test suites ready to run
2. **Coverage Report**: Current coverage with gaps
3. **Mock Objects**: Fixtures for dependencies
4. **Test Documentation**: Test scenario explanations
5. **CI Commands**: Pipeline integration commands
