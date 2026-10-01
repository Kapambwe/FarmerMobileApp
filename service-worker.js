/* Manifest version: PRPCnTPI */
self.importScripts("./service-worker-assets.js");

const cachePrefix = "farmer-mobile-shell-";
const cacheName = `${cachePrefix}${self.assetsManifest.version}`;
const runtimeCacheName = `${cacheName}-runtime`;
const tileCacheName = `${runtimeCacheName}-tiles`;
const appBaseUrl = new URL(self.registration.scope);
const maxRuntimeEntries = 300;
const offlineAssetPatterns = [
    /\.dll$/i, /\.pdb$/i, /\.wasm$/i, /\.html$/i, /\.js$/i, /\.json$/i,
    /\.css$/i, /\.woff2?$/i, /\.png$/i, /\.jpe?g$/i, /\.gif$/i,
    /\.ico$/i, /\.blat$/i, /\.dat$/i, /\.webmanifest$/i
];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const assets = self.assetsManifest.assets
            .filter(asset => offlineAssetPatterns.some(pattern => pattern.test(asset.url)))
            .filter(asset => !asset.url.endsWith("service-worker.js"))
            .map(asset => new Request(new URL(asset.url, appBaseUrl), {
                integrity: asset.hash,
                cache: "no-cache",
                credentials: "same-origin"
            }));

        const cache = await caches.open(cacheName);
        const results = await Promise.allSettled(assets.map(asset => cache.add(asset)));
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length > 0) {
            console.warn(`Farmer Mobile cached ${assets.length - failures.length}/${assets.length} shell assets; missing assets will be fetched on demand.`);
        }
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const cacheKeys = await caches.keys();
        const activeCaches = new Set([cacheName, runtimeCacheName, tileCacheName]);
        await Promise.all(cacheKeys
            .filter(key => key.startsWith(cachePrefix) && !activeCaches.has(key))
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const requestUrl = new URL(request.url);
    if (request.method === "GET" && isMapTile(requestUrl)) {
        event.respondWith(cacheMapTile(request));
        return;
    }
    if (request.method !== "GET" ||
        requestUrl.origin !== appBaseUrl.origin ||
        !requestUrl.pathname.startsWith(appBaseUrl.pathname) ||
        isApiPath(requestUrl.pathname) ||
        requestUrl.pathname.endsWith("/service-worker.js")) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                if (response.ok) {
                    const cache = await caches.open(cacheName);
                    await cache.put(new URL("index.html", appBaseUrl), response.clone());
                }
                return response;
            } catch {
                const cachedShell = await caches.match(new URL("index.html", appBaseUrl));
                if (cachedShell) return cachedShell;
                throw new Error("Farmer Mobile has not been installed for offline use on this device.");
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const staticCache = await caches.open(cacheName);
        const staticResponse = await staticCache.match(request);
        if (staticResponse) return staticResponse;

        const runtimeCache = await caches.open(runtimeCacheName);
        try {
            const response = await fetch(request);
            if (response.ok && response.type === "basic") {
                await runtimeCache.put(request, response.clone());
                await trimRuntimeEntries(runtimeCache);
            }
            return response;
        } catch {
            const cachedResponse = await runtimeCache.match(request);
            if (cachedResponse) return cachedResponse;
            throw new Error(`This app asset is not available offline: ${requestUrl.pathname}`);
        }
    })());
});

function isApiPath(pathname) {
    const relativePath = pathname.slice(appBaseUrl.pathname.length).replace(/^\/+/, "");
    return relativePath === "api" || relativePath.startsWith("api/");
}

function isMapTile(url) {
    return url.hostname === "tile.openstreetmap.org" || url.hostname.endsWith(".tile.openstreetmap.org");
}

async function cacheMapTile(request) {
    const cache = await caches.open(tileCacheName);
    try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw new Error("Map tile is not available offline.");
    }
}

async function trimRuntimeEntries(cache) {
    const keys = await cache.keys();
    if (keys.length > maxRuntimeEntries) {
        await Promise.all(keys.slice(0, keys.length - maxRuntimeEntries).map(request => cache.delete(request)));
    }
}
