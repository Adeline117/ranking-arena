/**
 * User profile layout.
 *
 * NOTE: generateMetadata lives in page.tsx — when both layout.tsx and page.tsx
 * declare generateMetadata at the same route segment, Next.js uses the deeper
 * one (page.tsx wins). Keeping it here was dead code and shipped an inferior
 * OG image (bare avatar instead of 1200x630 card).
 */
export default function UserLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
