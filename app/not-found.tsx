import NotFoundContent from './components/NotFoundContent'

/**
 * Root 404 — completely unmatched URLs (e.g. /totally-nonexistent-xyz).
 * There is NO TopNav in this tree, so NotFoundContent renders its own
 * fixed mini header for navigation.
 *
 * notFound() thrown inside (app) pages is handled by app/(app)/not-found.tsx
 * instead (same content, no mini header — TopNav is already there).
 */
export default function NotFoundPage() {
  return <NotFoundContent />
}
