/**
 * Performance Budget Configuration
 * 
 * Defines target metrics for Core Web Vitals and bundle size.
 * Used by monitoring tools and CI checks.
 */

export const performanceBudget = {
  /** Core Web Vitals targets */
  webVitals: {
    /** Largest Contentful Paint — should be < 2.5s for "good" */
    LCP: { good: 2500, needsImprovement: 4000, unit: 'ms' as const },
    /** First Input Delay — should be < 100ms for "good" */
    FID: { good: 100, needsImprovement: 300, unit: 'ms' as const },
    /** Interaction to Next Paint (FID successor) */
    INP: { good: 200, needsImprovement: 500, unit: 'ms' as const },
    /** Cumulative Layout Shift — should be < 0.1 for "good" */
    CLS: { good: 0.1, needsImprovement: 0.25, unit: 'score' as const },
    /** Time to First Byte */
    TTFB: { good: 800, needsImprovement: 1800, unit: 'ms' as const },
    /** First Contentful Paint */
    FCP: { good: 1800, needsImprovement: 3000, unit: 'ms' as const },
  },

  /** Bundle size budgets (gzipped) */
  bundle: {
    /** First-load JS budget for homepage */
    firstLoadJS: { max: 300, unit: 'KB' as const },
    /** Individual chunk size limit */
    maxChunkSize: { max: 150, unit: 'KB' as const },
  },

  /** API response time budgets */
  api: {
    /** Warn threshold for slow API responses */
    slowThreshold: 1000, // ms
    /** Critical threshold */
    criticalThreshold: 3000, // ms
  },
} as const

export type MetricName = keyof typeof performanceBudget.webVitals
