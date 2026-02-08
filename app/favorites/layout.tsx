import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Favorites',
}

export default function FavoritesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
