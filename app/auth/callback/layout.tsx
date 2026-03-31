export const revalidate = 0 // Auth callback: no cache

export default function AuthCallbackLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
