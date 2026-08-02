import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Vite-Konfig. Die SPA ist gleichzeitig die installierbare PWA.
 *
 * Kern: das `share_target` im Manifest. Damit kann man aus jeder App
 * heraus "Teilen → lokyy-brain" wählen — der Browser POSTet den Share an
 * /api/pipes/share, wo die Pipe-Queue ihn aufgreift.
 *
 * Achtung: Web Share Target unterstützt nur Android/Chromium. Auf iOS
 * braucht es einen Fallback (Shortcut, der ans Backend postet).
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        // Phase D Wave D1 / Story 3 — Manifest alignment with the brand
        // palette (theme.ts) + dedicated brand PWA icons. The icons below
        // are the brain HEAD emblem on the brand background (#13171D),
        // generated at native sizes into pwa/public/: icon-192.png,
        // icon-512.png (purpose "any") and icon-maskable-512.png (maskable
        // safe-zone variant). No downsampling — each declared size ships
        // its own asset.
        name: "Lokyy Brain",
        short_name: "Lokyy",
        description: "Knowledge-Tool mit Forgejo als Wahrheit.",
        theme_color: "#13171D",
        background_color: "#13171D",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "portrait-primary",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Story 11.8 (Addendum §6): das `share_target` zielt auf die
        // PWA-Route `/share` (NICHT direkt aufs API) — dort fängt
        // ShareTarget.tsx den Share ab, postet via `api.share()` an das
        // bestehende `POST /api/pipes/share` und zeigt eine Quittung statt
        // roher JSON-Antwort (YouTube-JSON-Bugfix).
        share_target: {
          action: "/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [{ name: "file", accept: ["image/*", "application/pdf"] }],
          },
        },
      },
      workbox: {
        // Story 11.8: der Browser POSTet den Web-Share an `/share`. Eine reine
        // SPA kann einen POST-Body nicht lesen — der Service Worker fängt den
        // POST ab, parkt die FormData (inkl. Datei) kurz im Cache und
        // redirectet auf GET `/share`, das die SPA als ShareTarget rendert.
        // Der GET-Handler liest die geparkte FormData wieder aus.
        importScripts: ["/share-sw.js"],
        // Workbox precacht standardmäßig nur Assets < 2 MiB. Das Main-Bundle
        // liegt bei ~2,1 MB und lag zuvor knapp UNTER dieser Grenze — jede
        // kleine Änderung kippte den Build (`maximumFileSizeToCacheInBytes`-
        // Fehler) bzw. hätte das Bundle still aus dem Precache fallen lassen
        // und damit den Offline-Modus degradiert. 4 MiB gibt echten Headroom
        // (~2x aktuelle Bundle-Größe) und erhält das bisherige Verhalten.
        // Langfristig ist Code-Splitting via `build.rollupOptions.output
        // .manualChunks` die eigentliche Lösung — Vite warnt bei jedem Build
        // über den >500-kB-Chunk. Bewusst NICHT Teil dieser Änderung.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // API-Calls nicht aggressiv cachen — Forgejo ist die Wahrheit.
        // Top-level navigations to /api/** (e.g. OAuth start redirects) must
        // bypass the SPA's navigateFallback so the browser hits the network
        // and receives the backend's 302 instead of a cached index.html.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\/notes/,
            handler: "NetworkFirst",
            options: {
              cacheName: "notes",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/api\/vault\/tree/,
            handler: "NetworkFirst",
            options: {
              cacheName: "vault-tree",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            urlPattern: /\/api\/graph/,
            handler: "NetworkFirst",
            options: {
              cacheName: "graph",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
