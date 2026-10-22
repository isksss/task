import { getPrecacheUrls, isNetworkOnlyPath, notificationTargetUrl, shouldUseAppShellFallback } from "./sw-routing";

type PrecacheEntry = { url: string; revision?: string | null };
type WaitableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchWorkerEvent = WaitableEvent & {
  request: Request;
  respondWith(response: Promise<Response>): void;
};
type PushWorkerEvent = WaitableEvent & { data?: { json(): unknown } | null };
type ClickWorkerEvent = WaitableEvent & {
  notification: Notification;
};
type WindowClient = {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<WindowClient | null>;
};
type WorkerScope = EventTarget & {
  __WB_MANIFEST: PrecacheEntry[];
  location: Location;
  registration: {
    scope: string;
    showNotification(title: string, options: { body?: string; icon?: string; badge?: string; data?: unknown }): Promise<void>;
  };
  caches: CacheStorage;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  skipWaiting(): Promise<void>;
};

declare const self: WorkerScope;
const worker = self;
const precacheManifest = self.__WB_MANIFEST;
const cachePrefix = "task-precache-";
const appRevision = precacheManifest.find(({ url }) => url === "index.html")?.revision ?? "current";
const cacheName = `${cachePrefix}${appRevision}`;
const appShellUrl = new URL("index.html", worker.registration.scope).href;
const precacheUrls = getPrecacheUrls(precacheManifest, worker.registration.scope);

worker.addEventListener("install", (event: Event) => {
  (event as WaitableEvent).waitUntil(
    worker.caches.open(cacheName).then((cache) => cache.addAll(precacheUrls)),
  );
});

worker.addEventListener("activate", (event: Event) => {
  (event as WaitableEvent).waitUntil((async () => {
    const oldCaches = (await worker.caches.keys()).filter((name) => name.startsWith(cachePrefix) && name !== cacheName);
    await Promise.all(oldCaches.map((name) => worker.caches.delete(name)));
    await worker.clients.claim();
  })());
});

worker.addEventListener("message", (event: Event) => {
  if ((event as MessageEvent).data?.type === "SKIP_WAITING") void worker.skipWaiting();
});

worker.addEventListener("fetch", (event: Event) => {
  const fetchEvent = event as FetchWorkerEvent;
  const { request } = fetchEvent;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || isNetworkOnlyPath(url.pathname)) return;

  if (request.mode === "navigate") {
    fetchEvent.respondWith((async () => {
      try {
        return await fetch(request, { redirect: "manual" });
      } catch (error) {
        if (shouldUseAppShellFallback(request, undefined)) {
          const cache = await worker.caches.open(cacheName);
          const appShell = await cache.match(appShellUrl);
          if (appShell) return appShell;
        }
        throw error;
      }
    })());
    return;
  }

  if (request.method === "GET") {
    fetchEvent.respondWith((async () => {
      const cache = await worker.caches.open(cacheName);
      return (await cache.match(request)) ?? fetch(request);
    })());
  }
});

worker.addEventListener("push", (event: Event) => {
  const pushEvent = event as PushWorkerEvent;
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = pushEvent.data?.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // A malformed push still becomes a generic notification instead of being silently dropped.
  }
  const title = typeof payload.title === "string" ? payload.title.slice(0, 100) : "task";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 1000) : "";
  const target = new URL(notificationTargetUrl(payload.url, worker.location.origin));
  pushEvent.waitUntil(worker.registration.showNotification(title, {
    body,
    icon: new URL("icons/icon-192.png", worker.registration.scope).href,
    badge: new URL("icons/icon-192.png", worker.registration.scope).href,
    data: { url: target.href },
  }));
});

worker.addEventListener("notificationclick", (event: Event) => {
  const clickEvent = event as ClickWorkerEvent;
  clickEvent.notification.close();
  const rawUrl = (clickEvent.notification.data as { url?: unknown } | null)?.url;
  const target = new URL(notificationTargetUrl(rawUrl, worker.location.origin));
  clickEvent.waitUntil((async () => {
    const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === worker.location.origin);
    if (existing) {
      await existing.navigate?.(target.href);
      await existing.focus();
      return;
    }
    await worker.clients.openWindow(target.href);
  })());
});
