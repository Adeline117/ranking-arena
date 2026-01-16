/**
 * Service Worker
 * 提供离线支持和缓存策略
 */

const CACHE_NAME = 'ranking-arena-v1';
const OFFLINE_URL = '/offline';

// 预缓存的静态资源
const PRECACHE_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
];

// 需要缓存的 API 路由模式
const API_CACHE_ROUTES = [
  '/api/traders',
  '/api/market',
];

// 安装事件 - 预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] 预缓存静态资源');
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
              console.log('[SW] 删除旧缓存:', name);
              return caches.delete(name);
            })
        );
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
          console.log('[SW] 导航请求失败，尝试使用缓存:', error.message);
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

  // API 请求 - 网络优先，缓存作为回退
  if (url.pathname.startsWith('/api/')) {
    const shouldCache = API_CACHE_ROUTES.some(route => url.pathname.startsWith(route));
    
    if (shouldCache) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            // 只缓存成功的 GET 请求
            if (request.method === 'GET' && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, responseClone);
              });
            }
            return response;
          })
          .catch(async () => {
            const cachedResponse = await caches.match(request);
            if (cachedResponse) {
              return cachedResponse;
            }
            // 返回标准的服务不可用响应
            return new Response(
              JSON.stringify({ error: 'Service unavailable', offline: true }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          })
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

// 后台同步
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-posts') {
    event.waitUntil(syncPosts());
  }
});

// 推送通知
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
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

// 同步帖子函数（示例）
async function syncPosts() {
  // 实现离线时保存的帖子同步逻辑
  console.log('[SW] 同步帖子');
}
