'use client'

/**
 * SkipToContent - Accessible skip navigation link
 *
 * Re-exports the existing SkipLink from Accessibility module.
 * This provides an alternative import path for the skip-to-content component.
 *
 * The component is visually hidden until focused via keyboard (Tab),
 * allowing screen reader and keyboard users to skip directly to main content.
 *
 * Already integrated in the root layout via:
 *   <SkipLink targetId="main-content" />
 */
export { SkipLink as SkipToContent, SkipLink as default } from '../Providers/Accessibility'
