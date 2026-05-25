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
        name: "lokyy-brain",
        short_name: "lokyy-brain",
        description: "Knowledge-Tool mit Forgejo als Wahrheit.",
        theme_color: "#14110f",
        background_color: "#14110f",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
        share_target: {
          action: "/api/pipes/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "file",
                accept: ["audio/*", "text/*"],
              },
            ],
          },
        },
      },
      workbox: {
        // API-Calls nicht aggressiv cachen — Forgejo ist die Wahrheit.
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
