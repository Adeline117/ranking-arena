// Metadata is generated in page.tsx — no duplicate generateMetadata here
// ISR: match page.tsx revalidate (5 min) — layout revalidate must be <= page
export const revalidate = 300

export default function TraderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
