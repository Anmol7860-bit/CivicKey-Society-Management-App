// Shows a pushed notification and opens the app where it points. Nothing is cached here: the
// service worker exists for push, and an offline page that served stale gate data would be worse
// than no offline page at all.
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = payload.title || 'CivicKey'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      tag: payload.id || undefined,
      data: { url: payload.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse a tab that is already open rather than piling up new ones
      const open = clients.find((client) => 'focus' in client)
      if (open) return open.focus()
      return self.clients.openWindow(url)
    }),
  )
})
