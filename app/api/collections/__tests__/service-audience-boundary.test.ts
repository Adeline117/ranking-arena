import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('collection service-role audience boundary', () => {
  it('authorizes the direct-id collection and every polymorphic item at request time', () => {
    const route = read('app/api/collections/[id]/route.ts')
    const audienceFilter = route.indexOf('filterServiceReadableCollectionItems(')
    const currentItemRebind = route.indexOf('rebindServiceReadableCollectionItems(')
    const finalCollectionRead = route.lastIndexOf('readCollectionCandidate(')

    expect(route).toContain('readPublicProfileAudienceById(')
    expect(route.match(/canReadCollection\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(route).toContain('filterServiceReadableCollectionItems(')
    expect(currentItemRebind).toBeGreaterThan(audienceFilter)
    expect(finalCollectionRead).toBeGreaterThan(currentItemRebind)
    expect(route).toContain(".in(\n          'id',")
    expect(route).toContain(".eq('collection_id', id)")
    expect(route).toContain('parseLimit(')
    expect(route).toContain('parseOffset(')
    expect(route).toContain('.range(offset, offset + limit)')
    expect(route).toContain('MAX_COLLECTION_ITEM_PAGE_SIZE = 100')
    expect(route).toContain('pagination:')
    expect(route).toContain('getAuthUser(request)')
    expect(route).not.toContain('if (collection.user_id === actorId) return true')
    expect(route).not.toContain('substring(7)')
    expect(route).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(route).toContain("'CDN-Cache-Control': 'no-store'")
    expect(route).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
  })

  it('re-authorizes the profile collection listing and counts only readable current items', () => {
    const route = read('app/api/users/[handle]/collections/route.ts')
    const candidateRead = route.indexOf(".from('user_collections')")
    const audienceFilter = route.indexOf('filterServiceReadableCollectionItems(')
    const currentItemRebind = route.indexOf('rebindServiceReadableCollectionItems(')
    const currentCollectionRead = route.lastIndexOf(".from('user_collections')")
    const currentHandleRead = route.lastIndexOf('readPublicProfileAudienceByHandle(')

    expect(route).toContain('filterServiceReadableCollectionItems(')
    expect(route).toContain(".from('collection_items')")
    expect(route).not.toContain('collection_items(count)')
    expect(currentItemRebind).toBeGreaterThan(audienceFilter)
    expect(currentCollectionRead).toBeGreaterThan(currentItemRebind)
    expect(currentCollectionRead).toBeGreaterThan(candidateRead)
    expect(route.match(/readPublicProfileAudienceByHandle\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2
    )
    expect(currentHandleRead).toBeGreaterThan(candidateRead)
    expect(currentHandleRead).toBeGreaterThan(currentCollectionRead)
    expect(route).toContain('currentHandleAudience.profile.id !== audience.profile.id')
    expect(route).toContain(".eq('user_id', audience.profile.id)")
    expect(route).toContain(".eq('is_public', true)")
    expect(route).toContain('MAX_COLLECTION_AUDIENCE_ITEMS + 1')
    expect(route).toContain('.range(offset, offset + limit)')
    expect(route).toContain('MAX_PUBLIC_COLLECTION_PAGE_SIZE = 50')
    expect(route).toContain('item_counts_complete:')
    expect(route).toContain("'CDN-Cache-Control': 'no-store'")
    expect(route).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
  })

  it('fails the current-user listing closed across account-state transitions', () => {
    const route = read('app/api/collections/route.ts')
    const initialAudience = route.indexOf('const currentAudience =')
    const ensureDefaults = route.indexOf("supabase.rpc('ensure_default_collections'")
    const lockedDenial = route.indexOf("defaultsError.code === '42501'")
    const collectionRead = route.indexOf(".from('user_collections')")
    const releaseAudience = route.indexOf('const releaseAudience =')

    expect(initialAudience).toBeGreaterThan(-1)
    expect(ensureDefaults).toBeGreaterThan(initialAudience)
    expect(lockedDenial).toBeGreaterThan(ensureDefaults)
    expect(collectionRead).toBeGreaterThan(lockedDenial)
    expect(releaseAudience).toBeGreaterThan(collectionRead)
    expect(route).toContain("deniedAudience.status !== 'active'")
    expect(route).toContain("releaseAudience.status !== 'active'")
    expect(route).toContain("'Cache-Control': 'private, no-store, max-age=0'")
  })

  it('delegates collection and item writes to atomic RPCs with strict acknowledgements', () => {
    const collectionRoute = read('app/api/collections/[id]/route.ts')
    const itemRoute = read('app/api/collections/[id]/items/route.ts')
    const rootRoute = read('app/api/collections/route.ts')

    expect(collectionRoute).toContain("supabase.rpc('mutate_user_collection_atomic'")
    expect(itemRoute).toContain("supabase.rpc('mutate_collection_item_atomic'")
    expect(rootRoute).toContain("supabase.rpc('mutate_user_collection_atomic'")
    expect(collectionRoute).toContain('parseCollectionMutationAck(')
    expect(itemRoute).toContain('parseCollectionItemMutationAck(')
    expect(rootRoute).toContain('parseCollectionMutationAck(')

    expect(collectionRoute).not.toMatch(
      /\.from\(\s*['"]user_collections['"]\s*\)[\s\S]*?\.(?:update|delete)\(/
    )
    expect(itemRoute).not.toMatch(
      /\.from\(\s*['"]collection_items['"]\s*\)[\s\S]*?\.(?:insert|delete)\(/
    )
    expect(rootRoute).not.toMatch(/\.from\(\s*['"]user_collections['"]\s*\)[\s\S]*?\.insert\(/)
  })
})
