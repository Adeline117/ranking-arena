/**
 * Service Worker — v5
 * Push notifications + offline fallback only.
 * NO aggressive caching of HTML or static assets.
 * Previous versions cached HTML pages and returned empty 503 responses
 * for failed static asset fetches, causing white screens on mobile.
 */

const CACHE_NAME = 'ranking-arena-v5'
const OFFLINE_URL = '/offline'
const PUSH_VIEWER_CACHE_NAME = 'ranking-arena-push-viewer-v1'
const PUSH_VIEWER_CACHE_KEY = '/__arena/push-viewer'

function validPushViewerId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value)
}

async function writeActivePushViewer(userId) {
  const cache = await caches.open(PUSH_VIEWER_CACHE_NAME)
  if (!validPushViewerId(userId)) {
    await cache.delete(PUSH_VIEWER_CACHE_KEY)
    return
  }
  await cache.put(
    PUSH_VIEWER_CACHE_KEY,
    new Response(JSON.stringify({ userId }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  )
}

async function readActivePushViewer() {
  try {
    const cache = await caches.open(PUSH_VIEWER_CACHE_NAME)
    const response = await cache.match(PUSH_VIEWER_CACHE_KEY)
    if (!response) return null
    const stored = await response.json()
    return validPushViewerId(stored && stored.userId) ? stored.userId : null
  } catch (_error) {
    return null
  }
}

// Install: only cache the offline fallback page
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .then(() => self.skipWaiting())
  )
})

// Activate: delete ALL old caches, claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME && name !== PUSH_VIEWER_CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  )
})

// Fetch: only intercept navigation failures for offline fallback.
// All other requests pass through to the network untouched.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL)
      return (
        cached ||
        new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title></head><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;color:#666"><div style="text-align:center"><h1>Connection Failed</h1><p>Please check your network and try again.</p></div></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
      )
    })
  )
})

// Handle SKIP_WAITING message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (event.data && event.data.type === 'SET_ACTIVE_PUSH_VIEWER') {
    event.waitUntil(writeActivePushViewer(event.data.userId))
  }
})

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch (_e) {
    data = { title: 'Arena', body: event.data.text() }
  }

  const typeUrlMap = {
    rank_change: '/rankings',
    flash_news: '/flash-news',
    new_follower: '/notifications',
    post_reply: '/notifications',
  }

  const url = data.url || typeUrlMap[data.type] || '/'

  event.waitUntil(
    (async () => {
      if (data.recipientUserId) {
        if (!validPushViewerId(data.recipientUserId)) return
        const activeUserId = await readActivePushViewer()
        if (activeUserId !== data.recipientUserId) return
      }

      await self.registration.showNotification(data.title || 'Arena', {
        body: data.body,
        icon: data.icon || '/icons/icon-192x192.png',
        badge: '/icons/icon-192x192.png',
        vibrate: [100, 50, 100],
        tag: data.type || 'arena',
        data: { url, type: data.type, ...data.data },
        actions: [
          { action: 'open', title: 'View' },
          { action: 'close', title: 'Close' },
        ],
      })
    })()
  )
})

// Notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'open' || !event.action) {
    const url = event.notification.data?.url || '/'
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === url && 'focus' in client) {
            return client.focus()
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url)
        }
      })
    )
  }
})
