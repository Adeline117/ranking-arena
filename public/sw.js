/**
 * Service Worker
 * 提供离线支持和缓存策略
 */

const CACHE_NAME = 'ranking-arena-v3';
const OFFLINE_URL = '/offline';

// Maximum number of entries in the runtime cache
const MAX_CACHE_ENTRIES = 200;

// 预缓存的静态资源
const PRECACHE_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
  '/rankings',
  '/groups',
];

// API 缓存配置 - 路由模式及其 TTL（毫秒）
const API_CACHE_CONFIG = {
  // 核心数据 - 短缓存（5分钟）
  '/api/traders': 5 * 60 * 1000,
  '/api/market': 5 * 60 * 1000,
  '/api/hot': 5 * 60 * 1000,

  // 用户数据 - 中等缓存（15分钟）
  '/api/user/profile': 15 * 60 * 1000,
  '/api/followers': 15 * 60 * 1000,
  '/api/following': 15 * 60 * 1000,
  '/api/bookmarks': 15 * 60 * 1000,

  // 内容数据 - 中等缓存（15分钟）
  '/api/posts': 15 * 60 * 1000,
  '/api/comments': 15 * 60 * 1000,
  '/api/groups': 15 * 60 * 1000,

  // 交易员详情 - 长缓存（1小时）
  '/api/trader/': 60 * 60 * 1000,

  // 搜索结果 - 短缓存（5分钟）
  '/api/search': 5 * 60 * 1000,

  // 静态配置 - 长缓存（24小时）
  '/api/config': 24 * 60 * 60 * 1000,
  '/api/exchanges': 24 * 60 * 60 * 1000,
};

// 获取 API 路由的缓存 TTL
function getApiCacheTTL(pathname) {
  for (const [route, ttl] of Object.entries(API_CACHE_CONFIG)) {
    if (pathname.startsWith(route)) {
      return ttl;
    }
  }
  return null; // 不缓存
}

// 检查缓存是否过期
function isCacheExpired(response, ttl) {
  const cachedTime = response.headers.get('sw-cached-at');
  if (!cachedTime) return true;
  return Date.now() - parseInt(cachedTime, 10) > ttl;
}

// 安装事件 - 预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.warn('[SW] 预缓存静态资源');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        // 跳过等待，立即激活
        return self.skipWaiting();
      })
  );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.warn('[SW] 删除旧缓存:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        // Trim cache after cleanup
        return trimCache();
      })
      .then(() => {
        // 立即控制所有客户端
        return self.clients.claim();
      })
  );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源请求
  if (url.origin !== location.origin) {
    return;
  }

  // 导航请求 - 网络优先，失败时使用缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .catch(async (error) => {
          console.warn('[SW] 导航请求失败，尝试使用缓存:', error.message);
          const cachedResponse = await caches.match(OFFLINE_URL);
          // 确保始终返回有效的 Response
          if (cachedResponse) {
            return cachedResponse;
          }
          // 如果缓存也没有，返回基本的离线响应
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>离线</title></head><body><h1>网络连接失败</h1><p>请检查您的网络连接后重试。</p></body></html>',
            {
              status: 503,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        })
    );
    return;
  }

  // API 请求 - 网络优先，带 TTL 的缓存回退
  if (url.pathname.startsWith('/api/')) {
    const ttl = getApiCacheTTL(url.pathname);

    if (ttl !== null && request.method === 'GET') {
      event.respondWith(
        (async () => {
          // 先尝试从缓存获取
          const cachedResponse = await caches.match(request);

          // 如果有缓存且未过期，直接返回（同时后台更新）
          if (cachedResponse && !isCacheExpired(cachedResponse, ttl)) {
            // 后台更新缓存（stale-while-revalidate 策略）
            fetch(request).then(async (response) => {
              if (response.status === 200) {
                const cache = await caches.open(CACHE_NAME);
                // 添加缓存时间戳
                const headers = new Headers(response.headers);
                headers.set('sw-cached-at', Date.now().toString());
                const responseWithTimestamp = new Response(await response.blob(), {
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                });
                await cache.put(request, responseWithTimestamp);
              }
            }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- fire-and-forget, failure is non-critical

            return cachedResponse;
          }

          // 缓存不存在或已过期，发起网络请求
          try {
            const response = await fetch(request);

            if (response.status === 200) {
              const cache = await caches.open(CACHE_NAME);
              // 添加缓存时间戳
              const headers = new Headers(response.headers);
              headers.set('sw-cached-at', Date.now().toString());
              const responseWithTimestamp = new Response(await response.clone().blob(), {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
              await cache.put(request, responseWithTimestamp);
            }

            return response;
          } catch (_error) {
            // 网络请求失败，返回过期缓存（如果有的话）
            if (cachedResponse) {
              console.warn('[SW] 网络请求失败，返回过期缓存:', url.pathname);
              return cachedResponse;
            }

            // 无缓存时返回离线响应
            return new Response(
              JSON.stringify({ error: 'Service unavailable', offline: true }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
        })()
      );
      return;
    }
  }

  // 静态资源 - 缓存优先
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|gif|webp|woff|woff2)$/)
  ) {
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          return fetch(request)
            .then((response) => {
              if (response.status === 200) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(request, responseClone);
                });
              }
              return response;
            })
            .catch(() => {
              // 静态资源加载失败时返回空响应
              return new Response('', { status: 503 });
            });
        })
    );
    return;
  }

  // 其他请求 - 网络优先
  event.respondWith(
    fetch(request).catch(async () => {
      const cachedResponse = await caches.match(request);
      // 返回缓存响应或空响应（避免 undefined）
      return cachedResponse || new Response('', { status: 503 });
    })
  );
});

// Handle SKIP_WAITING message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 后台同步
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-posts') {
    event.waitUntil(syncPosts());
  }
});

// 推送通知
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (_e) {
    data = { title: 'Arena', body: event.data.text() };
  }

  // Route by payload type to relevant page
  const typeUrlMap = {
    rank_change: '/rankings',
    flash_news: '/flash-news',
    new_follower: '/notifications',
    post_reply: '/notifications',
  };

  const url = data.url || typeUrlMap[data.type] || '/';

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    vibrate: [100, 50, 100],
    tag: data.type || 'arena',
    data: {
      url,
      type: data.type,
      ...data.data,
    },
    actions: [
      { action: 'open', title: '查看' },
      { action: 'close', title: '关闭' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Arena', options)
  );
});

// 通知点击
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'open' || !event.action) {
    const url = event.notification.data?.url || '/';
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((windowClients) => {
        // 如果已有窗口，聚焦它
        for (const client of windowClients) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        // 否则打开新窗口
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
    );
  }
});

// Trim cache to MAX_CACHE_ENTRIES (FIFO)
async function trimCache() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_ENTRIES) {
    const toDelete = keys.slice(0, keys.length - MAX_CACHE_ENTRIES);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// 同步帖子函数（示例）
async function syncPosts() {
  // 实现离线时保存的帖子同步逻辑
  console.warn('[SW] 同步帖子');
}
