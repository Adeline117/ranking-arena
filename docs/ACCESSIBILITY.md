# Accessibility Guide

This document covers accessibility (a11y) features and best practices implemented in Arena.

## WCAG Compliance Target

Arena aims for WCAG 2.1 Level AA compliance.

## Implemented Features

### Skip Link

A skip link allows keyboard users to skip navigation and jump to main content:

```tsx
// app/components/Providers/Accessibility.tsx
<SkipLink targetId="main-content" />

// app/layout.tsx
<main id="main-content" tabIndex={-1}>
  {children}
</main>
```

### Focus Trap for Modals

Modals trap keyboard focus to prevent users from tabbing outside:

```tsx
// lib/hooks/useFocusTrap.ts
import { useAutoFocusTrap } from '@/lib/hooks/useFocusTrap'

function Modal({ isOpen, children }) {
  const modalRef = useAutoFocusTrap<HTMLDivElement>(isOpen)

  return (
    <div ref={modalRef} role="dialog" aria-modal="true">
      {children}
    </div>
  )
}
```

Features:
- Traps Tab/Shift+Tab within modal
- Returns focus to trigger element on close
- Focuses first focusable element on open

### Accessible Icon Buttons

Icon-only buttons must have `aria-label`:

```tsx
// app/components/ui/IconButton.tsx
<IconButton
  icon={<SearchIcon />}
  aria-label="Search"  // Required prop
  onClick={handleSearch}
/>
```

### ARIA Attributes

#### Toggle Buttons

```tsx
<button
  aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
  aria-pressed={favorited}
  onClick={toggleFavorite}
>
  {favorited ? '★' : '☆'}
</button>
```

#### Expandable Menus

```tsx
<button
  aria-expanded={isOpen}
  aria-haspopup="true"
  aria-label="Create post"
  onClick={toggleMenu}
>
  <PlusIcon />
</button>
```

#### Dialog/Modal

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title"
  aria-describedby="dialog-description"
>
  <h2 id="dialog-title">Confirm Action</h2>
  <p id="dialog-description">Are you sure?</p>
</div>
```

### Keyboard Navigation

#### Focus Indicators

Visible focus outlines for keyboard users:

```css
:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: 2px;
}
```

#### Keyboard Shortcuts

Global keyboard shortcuts are available (see `KeyboardShortcuts` component):

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `Esc` | Close modal |
| `Tab` | Navigate focusable elements |

### Screen Reader Support

#### Hidden Decorative Elements

```tsx
<span aria-hidden="true">{decorativeIcon}</span>
```

#### Live Regions for Toasts

```tsx
<div
  role="alert"
  aria-live="polite"
  aria-atomic="true"
>
  {toastMessage}
</div>
```

#### Descriptive Link Text

```tsx
// BAD
<a href="/profile">Click here</a>

// GOOD
<a href="/profile">View your profile</a>
```

### Color and Contrast

- All text meets WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text)
- Color is not the only way to convey information
- Focus states don't rely solely on color

### Form Accessibility

```tsx
<label htmlFor="email">Email address</label>
<input
  id="email"
  type="email"
  aria-required="true"
  aria-invalid={hasError}
  aria-describedby={hasError ? "email-error" : undefined}
/>
{hasError && (
  <span id="email-error" role="alert">
    Please enter a valid email
  </span>
)}
```

## Testing

### Automated Testing

- ESLint `jsx-a11y` plugin catches common issues
- Playwright tests verify keyboard navigation

### Manual Testing

1. **Keyboard-only navigation**: Tab through all interactive elements
2. **Screen reader testing**: Test with VoiceOver (Mac) or NVDA (Windows)
3. **Zoom testing**: Ensure layout works at 200% zoom
4. **Color blindness simulation**: Use browser dev tools

## Component Checklist

When building new components:

- [ ] All images have alt text
- [ ] Icon buttons have aria-label
- [ ] Interactive elements are focusable
- [ ] Focus order is logical
- [ ] Modals trap focus and have proper ARIA
- [ ] Form inputs have associated labels
- [ ] Error messages are announced to screen readers
- [ ] Color contrast meets WCAG AA
- [ ] Touch targets are at least 44x44px on mobile

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [MDN Accessibility Guide](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
- [React Accessibility Docs](https://reactjs.org/docs/accessibility.html)
