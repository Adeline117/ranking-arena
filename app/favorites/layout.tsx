import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Favorites',
  description: 'Your bookmarked traders and posts on Arena. Organize favorites into folders for quick access.',
}

export default function FavoritesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
