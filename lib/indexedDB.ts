/**
 * IndexedDB Storage Utility
 *
 * Provides offline storage for:
 * - Draft posts and comments
 * - Cached trader data
 * - Pending actions (sync when online)
 * - Recently viewed items
 */

const DB_NAME = 'arena-offline'
const DB_VERSION = 1

// Store names
export const STORES = {
  DRAFTS: 'drafts',
  CACHE: 'cache',
  PENDING_ACTIONS: 'pending_actions',
  RECENTLY_VIEWED: 'recently_viewed',
} as const

type StoreName = typeof STORES[keyof typeof STORES]

interface Draft {
  id: string
  type: 'post' | 'comment' | 'message'
  parentId?: string // For comments/replies
  content: string
  attachments?: string[]
  createdAt: number
  updatedAt: number
}

interface CacheEntry {
  key: string
  data: unknown
  expiresAt: number
  createdAt: number
}

interface PendingAction {
  id: string
  type: 'like' | 'follow' | 'bookmark' | 'post' | 'comment'
  payload: unknown
  createdAt: number
  retries: number
}

interface RecentlyViewed {
  id: string
  type: 'trader' | 'post' | 'group' | 'user'
  data: unknown
  viewedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Get or create the IndexedDB database
 */
function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not supported'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(request.error)
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Drafts store
      if (!db.objectStoreNames.contains(STORES.DRAFTS)) {
        const draftsStore = db.createObjectStore(STORES.DRAFTS, { keyPath: 'id' })
        draftsStore.createIndex('type', 'type', { unique: false })
        draftsStore.createIndex('updatedAt', 'updatedAt', { unique: false })
      }

      // Cache store
      if (!db.objectStoreNames.contains(STORES.CACHE)) {
        const cacheStore = db.createObjectStore(STORES.CACHE, { keyPath: 'key' })
        cacheStore.createIndex('expiresAt', 'expiresAt', { unique: false })
      }

      // Pending actions store
      if (!db.objectStoreNames.contains(STORES.PENDING_ACTIONS)) {
        const actionsStore = db.createObjectStore(STORES.PENDING_ACTIONS, { keyPath: 'id' })
        actionsStore.createIndex('type', 'type', { unique: false })
        actionsStore.createIndex('createdAt', 'createdAt', { unique: false })
      }

      // Recently viewed store
      if (!db.objectStoreNames.contains(STORES.RECENTLY_VIEWED)) {
        const recentStore = db.createObjectStore(STORES.RECENTLY_VIEWED, { keyPath: 'id' })
        recentStore.createIndex('type', 'type', { unique: false })
        recentStore.createIndex('viewedAt', 'viewedAt', { unique: false })
      }
    }
  })

  return dbPromise
}

/**
 * Generic get operation
 */
async function get<T>(storeName: StoreName, key: string): Promise<T | null> {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly')
    const store = transaction.objectStore(storeName)
    const request = store.get(key)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || null)
  })
}

/**
 * Generic put operation
 */
async function put<T>(storeName: StoreName, value: T): Promise<void> {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.put(value)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Generic delete operation
 */
async function remove(storeName: StoreName, key: string): Promise<void> {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.delete(key)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Get all items from a store
 */
async function getAll<T>(storeName: StoreName): Promise<T[]> {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly')
    const store = transaction.objectStore(storeName)
    const request = store.getAll()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || [])
  })
}

/**
 * Clear all items from a store
 */
async function clear(storeName: StoreName): Promise<void> {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.clear()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

// ============================================
// Drafts API
// ============================================

export const drafts = {
  async save(draft: Omit<Draft, 'createdAt' | 'updatedAt'> & { createdAt?: number }): Promise<void> {
    const now = Date.now()
    await put<Draft>(STORES.DRAFTS, {
      ...draft,
      createdAt: draft.createdAt || now,
      updatedAt: now,
    })
  },

  async get(id: string): Promise<Draft | null> {
    return get<Draft>(STORES.DRAFTS, id)
  },

  async getAll(): Promise<Draft[]> {
    const all = await getAll<Draft>(STORES.DRAFTS)
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async getByType(type: Draft['type']): Promise<Draft[]> {
    const all = await this.getAll()
    return all.filter(d => d.type === type)
  },

  async delete(id: string): Promise<void> {
    return remove(STORES.DRAFTS, id)
  },

  async clear(): Promise<void> {
    return clear(STORES.DRAFTS)
  },
}

// ============================================
// Cache API
// ============================================

export const cache = {
  async set(key: string, data: unknown, ttlMs: number = 5 * 60 * 1000): Promise<void> {
    const now = Date.now()
    await put<CacheEntry>(STORES.CACHE, {
      key,
      data,
      expiresAt: now + ttlMs,
      createdAt: now,
    })
  },

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = await get<CacheEntry>(STORES.CACHE, key)
    if (!entry) return null

    // Check expiration
    if (entry.expiresAt < Date.now()) {
      await this.delete(key)
      return null
    }

    return entry.data as T
  },

  async delete(key: string): Promise<void> {
    return remove(STORES.CACHE, key)
  },

  async clear(): Promise<void> {
    return clear(STORES.CACHE)
  },

  async cleanup(): Promise<void> {
    const all = await getAll<CacheEntry>(STORES.CACHE)
    const now = Date.now()
    const expired = all.filter(e => e.expiresAt < now)
    await Promise.all(expired.map(e => this.delete(e.key)))
  },
}

// ============================================
// Pending Actions API (for offline sync)
// ============================================

export const pendingActions = {
  async add(action: Omit<PendingAction, 'id' | 'createdAt' | 'retries'>): Promise<string> {
    const id = `${action.type}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await put<PendingAction>(STORES.PENDING_ACTIONS, {
      ...action,
      id,
      createdAt: Date.now(),
      retries: 0,
    })
    return id
  },

  async get(id: string): Promise<PendingAction | null> {
    return get<PendingAction>(STORES.PENDING_ACTIONS, id)
  },

  async getAll(): Promise<PendingAction[]> {
    const all = await getAll<PendingAction>(STORES.PENDING_ACTIONS)
    return all.sort((a, b) => a.createdAt - b.createdAt)
  },

  async incrementRetries(id: string): Promise<void> {
    const action = await this.get(id)
    if (action) {
      await put<PendingAction>(STORES.PENDING_ACTIONS, {
        ...action,
        retries: action.retries + 1,
      })
    }
  },

  async delete(id: string): Promise<void> {
    return remove(STORES.PENDING_ACTIONS, id)
  },

  async clear(): Promise<void> {
    return clear(STORES.PENDING_ACTIONS)
  },
}

// ============================================
// Recently Viewed API
// ============================================

const MAX_RECENT_ITEMS = 50

export const recentlyViewed = {
  async add(item: Omit<RecentlyViewed, 'viewedAt'>): Promise<void> {
    await put<RecentlyViewed>(STORES.RECENTLY_VIEWED, {
      ...item,
      viewedAt: Date.now(),
    })

    // Cleanup old items
    const all = await this.getAll()
    if (all.length > MAX_RECENT_ITEMS) {
      const toDelete = all.slice(MAX_RECENT_ITEMS)
      await Promise.all(toDelete.map(i => this.delete(i.id)))
    }
  },

  async get(id: string): Promise<RecentlyViewed | null> {
    return get<RecentlyViewed>(STORES.RECENTLY_VIEWED, id)
  },

  async getAll(): Promise<RecentlyViewed[]> {
    const all = await getAll<RecentlyViewed>(STORES.RECENTLY_VIEWED)
    return all.sort((a, b) => b.viewedAt - a.viewedAt)
  },

  async getByType(type: RecentlyViewed['type']): Promise<RecentlyViewed[]> {
    const all = await this.getAll()
    return all.filter(i => i.type === type)
  },

  async delete(id: string): Promise<void> {
    return remove(STORES.RECENTLY_VIEWED, id)
  },

  async clear(): Promise<void> {
    return clear(STORES.RECENTLY_VIEWED)
  },
}

// ============================================
// Initialization & Cleanup
// ============================================

export async function initOfflineStorage(): Promise<void> {
  try {
    await getDB()
    // Cleanup expired cache on init
    await cache.cleanup()
  } catch (error) {
    console.warn('[IndexedDB] Failed to initialize:', error)
  }
}

export async function clearAllOfflineData(): Promise<void> {
  await Promise.all([
    drafts.clear(),
    cache.clear(),
    pendingActions.clear(),
    recentlyViewed.clear(),
  ])
}
