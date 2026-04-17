/**
 * Design System Tokens
 * Trader-focused minimal theme with light/dark mode support
 * Enhanced with glassmorphism, gradients, and animations
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

/**
 * CSS-variable-based colors — these resolve at paint time so inline styles
 * automatically update when data-theme changes (no React re-render needed).
 * For values that don't have a CSS variable counterpart we fall back to
 * the JS theme-tokens (read once at call time).
 */
function getCssVarColors() {
  // Fallback for values without CSS vars (medals, overlay, etc.)
  const theme = getCurrentTheme()
  const fallback = getThemeTokens(theme).colors

  return {
    white: '#FFFFFF',
    black: '#000000',

    bg: {
      primary: 'var(--color-bg-primary)',
      secondary: 'var(--color-bg-secondary)',
      tertiary: 'var(--color-bg-tertiary)',
      hover: 'var(--color-bg-hover)',
    },

    text: {
      primary: 'var(--color-text-primary)',
      secondary: 'var(--color-text-secondary)',
      tertiary: 'var(--color-text-tertiary)',
      disabled: fallback.text.disabled,
    },

    border: {
      primary: 'var(--color-border-primary)',
      secondary: 'var(--color-border-secondary)',
      focus: fallback.border.focus,
    },

    accent: {
      primary: 'var(--color-accent-primary)',
      success: 'var(--color-accent-success)',
      warning: 'var(--color-accent-warning, #FFB800)',
      error: 'var(--color-accent-error)',
      brand: 'var(--color-brand)',
      brandHover: 'var(--color-brand-hover)',
      brandMuted: 'var(--color-brand-muted)',
      brandLight: 'var(--color-brand-accent, #c9b8db)',
      translated: fallback.accent.translated,
    },

    sentiment: {
      bull: 'var(--color-sentiment-bull)',
      bear: 'var(--color-sentiment-bear)',
      neutral: 'var(--color-sentiment-neutral)',
    },
    gauge: {
      extremeFear: 'var(--color-gauge-extreme-fear, #ea3943)',
      fear: 'var(--color-gauge-fear, #ea8c00)',
      neutral: 'var(--color-gauge-neutral, #f5c623)',
      greed: 'var(--color-gauge-greed, #93d900)',
      extremeGreed: 'var(--color-gauge-extreme-greed, #16c784)',
    },
    medal: fallback.medal,
    interactive: fallback.interactive,
    rating: fallback.rating,
    verified: {
      onchain: 'var(--color-verified-onchain)',
      web3: 'var(--color-verified-web3)',
    },
    overlay: fallback.overlay,
  }
}

// Export tokens object that dynamically reads theme
// Note: colors getter returns CSS variable references so inline styles
// automatically track theme changes without re-render
export const tokens = {
  // Colors use CSS variables for automatic theme tracking
  get colors() {
    return getCssVarColors()
  },
  
  // Spacing scale (8px base unit)
  spacing: {
    0: '0',
    0.5: '2px',  // 0.125rem — borders/accents
    1: '4px',    // 0.25rem
    1.5: '6px',  // 0.375rem
    2: '8px',    // 0.5rem
    2.5: '10px', // 0.625rem
    3: '12px',   // 0.75rem
    3.5: '14px', // 0.875rem
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
      sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', 'sans-serif'],
      mono: ['Menlo', 'Monaco', '"Courier New"', 'monospace'],
    },
    fontSize: {
      xs: '12px',    // 0.75rem — smallest readable size (note: iOS auto-zooms inputs < 16px, use .no-ios-zoom class)
      sm: '13px',    // 0.8125rem
      base: '14px',  // 0.875rem
      md: '16px',    // 1rem
      lg: '18px',    // 1.125rem
      xl: '20px',    // 1.25rem
      '2xl': '24px', // 1.5rem
      hero: '28px',  // 1.75rem — hero metrics (ROI/PnL)
      '3xl': '32px', // 2rem
      '4xl': '40px', // 2.5rem
      '5xl': '48px', // 3rem
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
      snug: 1.4,
      normal: 1.6,
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
    '3xl': '24px',
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
    '2xl': '0 24px 64px rgba(0, 0, 0, 0.3)',
    inner: 'inset 0 1px 2px rgba(0, 0, 0, 0.1)',
    innerLg: 'inset 0 2px 4px rgba(0, 0, 0, 0.15)',
    glow: '0 0 20px rgba(139, 111, 168, 0.3)',
    glowLg: '0 0 40px rgba(139, 111, 168, 0.4)',
    glowSuccess: '0 0 20px rgba(47, 229, 125, 0.3)',
    glowError: '0 0 20px rgba(255, 124, 124, 0.3)',
    glowWarning: '0 0 20px rgba(255, 193, 7, 0.3)',
    // Card hover shadow
    cardHover: '0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(139, 111, 168, 0.1)',
  },
  
  // Glassmorphism effects - Using CSS variables for theme-awareness
  glass: {
    // Background colors with transparency - these use CSS variables defined in globals.css
    bg: {
      light: 'var(--glass-bg-light)',
      medium: 'var(--glass-bg-medium)',
      heavy: 'var(--glass-bg-heavy)',
      dark: 'rgba(0, 0, 0, 0.4)',
      darkMedium: 'rgba(0, 0, 0, 0.6)',
      darkHeavy: 'rgba(0, 0, 0, 0.8)',
      // Theme-aware glass backgrounds
      primary: 'var(--glass-bg-primary)',
      secondary: 'var(--glass-bg-secondary)',
      tertiary: 'var(--glass-bg-tertiary)',
    },
    // Blur values
    blur: {
      none: 'none',
      xs: 'blur(4px)',
      sm: 'blur(8px)',
      md: 'blur(8px)',
      lg: 'blur(12px)',
      xl: 'blur(40px)',
    },
    // Border for glass elements - using CSS variables for theme-awareness
    border: {
      light: '1px solid var(--glass-border-light)',
      medium: '1px solid var(--glass-border-medium)',
      heavy: '1px solid var(--glass-border-heavy)',
      accent: '1px solid rgba(139, 111, 168, 0.3)',
    },
  },
  
  // Gradient presets
  gradient: {
    // Brand gradients
    primary: 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
    primaryHover: 'linear-gradient(135deg, #9d84b5 0%, #8b6fa8 100%)',
    primarySubtle: 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.05) 100%)',
    
    // Accent gradients
    purple: 'linear-gradient(135deg, #9B7EC8 0%, #7B5EA7 50%, #5E4580 100%)',
    purpleSubtle: 'linear-gradient(135deg, rgba(155, 126, 200, 0.15) 0%, rgba(94, 69, 128, 0.05) 100%)',
    
    // Status gradients
    success: 'linear-gradient(135deg, #2fe57d 0%, #22c55e 100%)',
    successSubtle: 'linear-gradient(135deg, rgba(47, 229, 125, 0.2) 0%, rgba(34, 197, 94, 0.05) 100%)',
    error: 'linear-gradient(135deg, #ff7c7c 0%, #ef4444 100%)',
    errorSubtle: 'linear-gradient(135deg, rgba(255, 124, 124, 0.2) 0%, rgba(239, 68, 68, 0.05) 100%)',
    warning: 'linear-gradient(135deg, #ffc107 0%, #f59e0b 100%)',
    warningSubtle: 'linear-gradient(135deg, rgba(255, 193, 7, 0.2) 0%, rgba(245, 158, 11, 0.05) 100%)',
    
    // Background gradients
    dark: 'linear-gradient(180deg, #0B0A10 0%, #14121C 100%)',
    darkRadial: 'radial-gradient(ellipse at top, #1C1926 0%, #0B0A10 100%)',
    mesh: 'radial-gradient(at 40% 20%, rgba(139, 111, 168, 0.15) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(124, 58, 237, 0.1) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(167, 139, 250, 0.1) 0px, transparent 50%)',
    
    // Card gradients
    card: 'linear-gradient(145deg, rgba(20, 18, 28, 0.95) 0%, rgba(11, 10, 16, 0.9) 100%)',
    cardHover: 'linear-gradient(145deg, rgba(28, 25, 38, 0.98) 0%, rgba(20, 18, 28, 0.95) 100%)',
    cardGlass: 'linear-gradient(165deg, rgba(28, 25, 38, 0.85) 0%, rgba(11, 10, 16, 0.75) 100%)',
    
    // Shimmer effect for loading states
    shimmer: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 50%, transparent 100%)',
    
    // Border gradients (for pseudo-elements)
    borderGlow: 'linear-gradient(135deg, rgba(139, 111, 168, 0.5) 0%, rgba(124, 58, 237, 0.3) 100%)',
    
    // Special
    purpleGold: 'linear-gradient(135deg, #8B5CF6 0%, #D4AF37 100%)',
  },
  
  // Animation timing functions
  easing: {
    // Standard easings
    linear: 'linear',
    ease: 'ease',
    easeIn: 'ease-in',
    easeOut: 'ease-out',
    easeInOut: 'ease-in-out',
    
    // Custom cubic-bezier curves
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',     // Material Design standard
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',    // Entering elements
    accelerate: 'cubic-bezier(0.4, 0, 1, 1)',    // Leaving elements
    sharp: 'cubic-bezier(0.4, 0, 0.6, 1)',       // Quick, sharp movements
    bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',  // Bouncy effect
    elastic: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',    // More elastic
    smooth: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',    // Very smooth
    spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)', // Spring-like
  },
  
  // Animation durations
  duration: {
    instant: '0ms',
    fast: '100ms',
    normal: '200ms',
    slow: '300ms',
    slower: '400ms',
    slowest: '500ms',
    // For complex animations
    enter: '250ms',
    exit: '200ms',
    expand: '300ms',
    collapse: '250ms',
    page: '400ms',
  },
  
  // Transitions (enhanced for smoother animations)
  transition: {
    fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    base: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '300ms cubic-bezier(0.4, 0, 0.2, 1)',
    bounce: '300ms cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    smooth: '400ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    spring: '500ms cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    // Property-specific
    colors: 'color 200ms ease, background-color 200ms ease, border-color 200ms ease',
    transform: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
    opacity: 'opacity 200ms ease',
    shadow: 'box-shadow 300ms cubic-bezier(0.4, 0, 0.2, 1)',
    all: 'all 300ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  
  // Z-index scale
  zIndex: {
    base: 0,
    dropdown: 100,
    sticky: 200,
    overlay: 300,
    modal: 400,
    popover: 500,
    tooltip: 600,
    toast: 700,
    max: 9999,
  },
  
  // Breakpoints
  breakpoint: {
    xs: '480px',
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  },

  // Icon sizes (standardized)
  iconSize: {
    xs: 12,
    sm: 16,
    md: 20,
    lg: 24,
    xl: 32,
    '2xl': 40,
  },

  // Touch targets (minimum sizes for accessibility)
  touchTarget: {
    min: 44,       // Minimum touch target size (Apple HIG)
    comfortable: 48,
    large: 56,
  },

  // Focus ring styles
  focusRing: {
    width: '2px',
    offset: '2px',
    color: 'var(--focus-ring-color, rgba(139, 111, 168, 0.5))',
    style: '2px solid var(--focus-ring-color, rgba(139, 111, 168, 0.5))',
  },
  
  // Animation keyframe names (reference for CSS)
  keyframes: {
    fadeIn: 'fadeIn',
    fadeOut: 'fadeOut',
    fadeInUp: 'fadeInUp',
    fadeInDown: 'fadeInDown',
    fadeInLeft: 'fadeInLeft',
    fadeInRight: 'fadeInRight',
    scaleIn: 'scaleIn',
    scaleOut: 'scaleOut',
    slideInUp: 'slideInUp',
    slideInDown: 'slideInDown',
    slideInLeft: 'slideInLeft',
    slideInRight: 'slideInRight',
    slideOutUp: 'slideOutUp',
    slideOutDown: 'slideOutDown',
    pulse: 'pulse',
    spin: 'spin',
    bounce: 'bounce',
    shake: 'shake',
    shimmer: 'shimmer',
    glow: 'glow',
  },
} as const

// Helper functions
export function getSpacing(value: keyof typeof tokens.spacing): string {
  return tokens.spacing[value]
}

export function getColor(path: string): string {
  const parts = path.split('.')
  let value: Record<string, unknown> | string = tokens.colors as Record<string, unknown>
  for (const part of parts) {
    if (typeof value === 'object' && value !== null && part in value) {
      value = value[part] as Record<string, unknown> | string
    }
  }
  return typeof value === 'string' ? value : ''
}

// Glass effect helper
export function getGlassStyle(variant: 'light' | 'medium' | 'heavy' = 'medium') {
  return {
    background: tokens.glass.bg[variant],
    backdropFilter: tokens.glass.blur.lg,
    WebkitBackdropFilter: tokens.glass.blur.lg,
    border: tokens.glass.border[variant],
  }
}

// Gradient text helper
export function getGradientTextStyle(gradient: keyof typeof tokens.gradient = 'primary') {
  return {
    background: tokens.gradient[gradient],
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  }
}

// Responsive helper
export const media = {
  xs: `@media (min-width: ${tokens.breakpoint.xs})`,
  sm: `@media (min-width: ${tokens.breakpoint.sm})`,
  md: `@media (min-width: ${tokens.breakpoint.md})`,
  lg: `@media (min-width: ${tokens.breakpoint.lg})`,
  xl: `@media (min-width: ${tokens.breakpoint.xl})`,
  '2xl': `@media (min-width: ${tokens.breakpoint['2xl']})`,
  // Motion preferences
  reducedMotion: '@media (prefers-reduced-motion: reduce)',
  motion: '@media (prefers-reduced-motion: no-preference)',
} as const

// Animation helper for staggered children
export function getStaggerDelay(index: number, baseDelay: number = 50): string {
  return `${index * baseDelay}ms`
}

// Export type for tokens
// Rank colors for leaderboards (gold, silver, bronze)
export const rankColors = {
  gold: '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
} as const

export const RANK_COLORS_ARRAY = [rankColors.gold, rankColors.silver, rankColors.bronze] as const

// News category color map
export const newsCategories = {
  crypto:     { color: '#f59e0b' },
  macro:      { color: '#3b82f6' },
  defi:       { color: '#10b981' },
  regulation: { color: '#8b5cf6' },
  market:     { color: '#06b6d4' },
  // Extended category colors for news display
  btcEth:     { color: '#f7931a' },
  exchange:   { color: '#f59e0b' },
} as const

// News importance color map
export const newsImportance = {
  breaking: { color: '#ef4444' },
  important: { color: '#f97316' },
} as const

export type DesignTokens = typeof tokens
