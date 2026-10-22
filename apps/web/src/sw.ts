import { getPrecacheUrls, isNetworkOnlyPath, shouldUseAppShellFallback } from "./sw-routing";

type PrecacheEntry = { url: string; revision?: string | null };
type WaitableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchWorkerEvent = WaitableEvent & {
  request: Request;
  respondWith(response: Promise<Response>): void;
};
type WorkerScope = EventTarget & {
  __WB_MANIFEST: PrecacheEntry[];
  location: Location;
  registration: { scope: string };
  caches: CacheStorage;
  clients: { claim(): Promise<void> };
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

// Push payload display and notification navigation are added with Web Push.
worker.addEventListener("push", () => {});
worker.addEventListener("notificationclick", () => {});
