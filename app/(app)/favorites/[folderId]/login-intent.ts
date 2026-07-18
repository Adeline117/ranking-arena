export function buildFavoriteFolderReturnPath(folderId: string): string {
  const normalizedFolderId = folderId.trim()
  return normalizedFolderId ? `/favorites/${encodeURIComponent(normalizedFolderId)}` : '/favorites'
}

export function buildFavoriteFolderLoginHref(folderId: string): string {
  return `/login?returnUrl=${encodeURIComponent(buildFavoriteFolderReturnPath(folderId))}`
}
