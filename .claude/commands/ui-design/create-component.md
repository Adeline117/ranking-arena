# Create Component

Guided workflow for creating new UI components following established patterns and best practices.

## Requirements

Create component: **$ARGUMENTS**

## Pre-flight Checks

1. Detect framework (React, Vue, Svelte, Angular)
2. Detect styling approach (CSS Modules, Tailwind, styled-components)
3. Load project conventions

## Component Specification

### Questions (one at a time)

1. **Component Name** - PascalCase, descriptive
2. **Purpose** - Display, Input, Navigation, Feedback, Layout
3. **Complexity** - Simple, Compound, Complex
4. **Props** - Name, Type, Required/Optional, Default
5. **State** - Stateless, Local, Controlled, Uncontrolled
6. **Composition** - No children, Simple children, Slots, Compound
7. **Accessibility** - Basic, Keyboard nav, Screen reader, WCAG AA
8. **Styling** - CSS Modules, Tailwind, Styled Components

## Directory Structure

```
{ComponentName}/
├── index.ts                    # Barrel export
├── {ComponentName}.tsx         # Main component
├── {ComponentName}.test.tsx    # Tests
├── {ComponentName}.styles.css  # Styles
└── types.ts                    # TypeScript types
```

## Generated Files

### Component (React + TypeScript)
```typescript
import { forwardRef, HTMLAttributes } from 'react';
import styles from './Button.styles.css';

export interface ButtonProps extends HTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`${styles.button} ${styles[variant]} ${styles[size]}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
```

### Types
```typescript
import { HTMLAttributes } from 'react';

export interface ButtonProps extends HTMLAttributes<HTMLButtonElement> {
  /** Visual variant of the button */
  variant?: 'primary' | 'secondary';
  /** Size of the button */
  size?: 'sm' | 'md' | 'lg';
}
```

### Tests
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Button } from './Button';

describe('Button', () => {
  it('renders without crashing', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Button>Click</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });
});
```

### Barrel Export
```typescript
export { Button } from './Button';
export type { ButtonProps } from './types';
```

## Storybook Integration (Optional)

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: 'primary', children: 'Primary Button' },
};

export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Secondary Button' },
};
```

## Output

- Component file with proper types
- Test file with accessibility tests
- Styles file
- Barrel export
- Storybook stories (if applicable)
