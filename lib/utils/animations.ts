/**
 * Shared Animation Constants & Utilities
 *
 * Central reference for animation timing, easing curves, and CSS class names
 * used across the app. All values align with design-tokens.ts and globals.css.
 *
 * Performance rules:
 *  - Only animate `transform` and `opacity` (GPU-composited)
 *  - Keep durations 150–300 ms for micro-interactions
 *  - Respect `prefers-reduced-motion` via the CSS layer (globals.css)
 */

import { tokens } from '@/lib/design-tokens'

// ── Easing curves ──────────────────────────────────────────
export const easing = {
  /** Material standard – general purpose */
  standard: tokens.easing.standard,
  /** Elements entering the screen */
  decelerate: tokens.easing.decelerate,
  /** Elements leaving the screen */
  accelerate: tokens.easing.accelerate,
  /** Quick, snappy */
  sharp: tokens.easing.sharp,
  /** Subtle overshoot (toasts, modals) */
  spring: tokens.easing.spring,
  /** Playful overshoot */
  bounce: tokens.easing.bounce,
} as const

// ── Duration scale (ms) ────────────────────────────────────
export const duration = {
  instant: 0,
  fast: 100,
  normal: 200,
  slow: 300,
  enter: 250,
  exit: 200,
  page: 400,
  countUp: 500,
} as const

// ── Transition shorthands ──────────────────────────────────
export const transition = {
  /** Hover lift: translateY + shadow */
  cardHover: `transform ${duration.normal}ms ${easing.standard}, box-shadow ${duration.normal}ms ${easing.standard}`,
  /** Button press: scale feedback */
  buttonPress: `transform ${duration.fast}ms ${easing.sharp}`,
  /** Tab indicator slide */
  tabIndicator: `left 250ms ${easing.standard}, width 250ms ${easing.standard}`,
  /** Modal open/close */
  modal: `transform ${duration.enter}ms ${easing.spring}, opacity ${duration.enter}ms ${easing.decelerate}`,
  /** Toast slide-in */
  toast: `transform ${duration.slow}ms ${easing.spring}, opacity ${duration.normal}ms ${easing.decelerate}`,
  /** Page content fade */
  page: `opacity ${duration.page}ms ${easing.decelerate}, transform ${duration.page}ms ${easing.decelerate}`,
  /** Generic color transition */
  color: tokens.transition.colors,
  /** Generic opacity transition */
  opacity: tokens.transition.opacity,
} as const

// ── CSS class names (defined in globals.css) ───────────────
export const animationClass = {
  /** Subtle lift on hover (-2px + shadow) */
  hoverLift: 'hover-lift',
  /** Scale 0.97 on press */
  pressEffect: 'press-effect',
  /** Fade-in on mount */
  fadeIn: 'fade-in',
  /** Page enter (fade + translateY 8px) */
  pageEnter: 'page-enter',
  /** Page slide-in from left */
  pageSlideIn: 'page-slide-in',
  /** Scale-in (0.98 → 1) */
  pageScaleIn: 'page-scale-in',
  /** Parent class: children fade in with staggered delay */
  staggerFade: 'stagger-fade',
  /** Parent class: children use --stagger-index CSS var */
  staggerEnter: 'stagger-enter',
  /** Skeleton shimmer loading state */
  skeleton: 'skeleton',
  /** Glass card with hover lift + glow */
  glassCard: 'glass-card',
  /** Generic card hover pattern */
  cardHover: 'card-hover',
  /** Tab bar container */
  tabBar: 'tab-bar',
  /** Sliding tab underline */
  tabIndicator: 'tab-indicator',
  /** Toast slide-in from top */
  toastSlideInTop: 'toast-slide-in-top',
  /** Modal backdrop + content animation */
  modalOverlay: 'modal-overlay-anim',
  modalContent: 'modal-content-anim',
} as const

// ── Stagger helper ─────────────────────────────────────────
/**
 * Returns a CSS custom-property style object for stagger-enter children.
 * Usage: <div style={staggerStyle(index)} />
 */
export function staggerStyle(index: number, baseDelayMs = 40): React.CSSProperties {
  return { '--stagger-index': index, animationDelay: `${index * baseDelayMs}ms` } as React.CSSProperties
}

/**
 * Checks if the user prefers reduced motion (client-side only).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ── Keyframe names (match globals.css @keyframes) ──────────
export const keyframes = tokens.keyframes
