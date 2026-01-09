/**
 * Design System Tokens
 * Trader-focused minimal theme with light/dark mode support
 */

import { getThemeTokens, type Theme } from './theme-tokens'

// Get current theme from document or default to dark
function getCurrentTheme(): Theme {
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.getAttribute('data-theme') as Theme
    return theme === 'light' || theme === 'dark' ? theme : 'dark'
  }
  return 'dark'
}

// Get theme-specific tokens
function getThemeColors() {
  const theme = getCurrentTheme()
  return getThemeTokens(theme).colors
}

// Export tokens object that dynamically reads theme
// Note: colors is a getter that reads from document.documentElement
// This allows components to access tokens.colors directly
export const tokens = {
  // Colors are dynamically loaded based on theme
  get colors() {
    return getThemeColors()
  },
  
  // Spacing scale (8px base unit)
  spacing: {
    0: '0',
    1: '4px',    // 0.25rem
    2: '8px',    // 0.5rem
    3: '12px',   // 0.75rem
    4: '16px',   // 1rem
    5: '20px',   // 1.25rem
    6: '24px',   // 1.5rem
    8: '32px',   // 2rem
    10: '40px',  // 2.5rem
    12: '48px',  // 3rem
    16: '64px',  // 4rem
    20: '80px',  // 5rem
  },
  
  // Typography
  typography: {
    fontFamily: {
      sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      mono: ['Menlo', 'Monaco', '"Courier New"', 'monospace'],
    },
    fontSize: {
      xs: '11px',    // 0.6875rem
      sm: '13px',    // 0.8125rem
      base: '14px',  // 0.875rem
      md: '16px',    // 1rem
      lg: '18px',    // 1.125rem
      xl: '20px',    // 1.25rem
      '2xl': '24px', // 1.5rem
      '3xl': '32px', // 2rem
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
      black: 900,
    },
    lineHeight: {
      tight: 1.2,
      normal: 1.5,
      relaxed: 1.75,
    },
  },
  
  // Border radius
  radius: {
    none: '0',
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    '2xl': '20px',
    full: '9999px',
  },
  
  // Shadows (enhanced for better depth)
  shadow: {
    none: 'none',
    xs: '0 1px 2px rgba(0, 0, 0, 0.05)',
    sm: '0 2px 4px rgba(0, 0, 0, 0.1)',
    md: '0 4px 12px rgba(0, 0, 0, 0.15)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.2)',
    xl: '0 16px 48px rgba(0, 0, 0, 0.25)',
    inner: 'inset 0 1px 2px rgba(0, 0, 0, 0.1)',
    glow: '0 0 20px rgba(139, 111, 168, 0.3)',
  },
  
  // Transitions (enhanced for smoother animations)
  transition: {
    fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    base: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '300ms cubic-bezier(0.4, 0, 0.2, 1)',
    bounce: '300ms cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  },
  
  // Z-index scale
  zIndex: {
    base: 0,
    dropdown: 100,
    sticky: 200,
    overlay: 300,
    modal: 400,
    popover: 500,
  },
  
  // Breakpoints
  breakpoint: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  },
} as const

// Helper functions
export function getSpacing(value: keyof typeof tokens.spacing): string {
  return tokens.spacing[value]
}

export function getColor(path: string): string {
  const parts = path.split('.')
  let value: any = tokens.colors
  for (const part of parts) {
    value = value[part]
  }
  return value
}

// Responsive helper
export const media = {
  sm: `@media (min-width: ${tokens.breakpoint.sm})`,
  md: `@media (min-width: ${tokens.breakpoint.md})`,
  lg: `@media (min-width: ${tokens.breakpoint.lg})`,
  xl: `@media (min-width: ${tokens.breakpoint.xl})`,
} as const
