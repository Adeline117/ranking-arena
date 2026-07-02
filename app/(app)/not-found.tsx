import NotFoundContent from '@/app/components/NotFoundContent'

/**
 * (app)-segment 404 — catches notFound() thrown from pages inside the (app)
 * layout (e.g. /wrapped/[handle] with an unknown handle, data-gated rankings
 * pages). Renders INSIDE the app shell, so TopNav / MobileBottomNav are
 * already present.
 *
 * Must NOT render the root 404's fixed mini header: that header (60px,
 * zIndex.sticky=200) stacked on top of TopNav and intercepted clicks on the
 * EN / theme / Login buttons — the exhaustive-sweep dead-click bug (2026-07).
 */
export default function AppNotFound() {
  return <NotFoundContent inAppShell />
}
