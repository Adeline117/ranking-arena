/**
 * Server shell for /favorites (Wave-3 SSR conversion).
 *
 * The shell streams immediately (metadata lives in layout.tsx); the
 * interactive body — auth session, bookmark folders fetching — stays in
 * the client leaf behind Suspense. No data fetching moved to the server yet.
 */

// 2026-07-04 #4:收敛到统一"我的收藏"hub。/favorites 列表重定向到 hub 的帖子 tab
// (FavoritesPageClient 在 hub 里复用);/favorites/[folderId] 深链保留不变。
import { redirect } from 'next/navigation'

export default function FavoritesPage() {
  redirect('/saved?tab=posts')
}
