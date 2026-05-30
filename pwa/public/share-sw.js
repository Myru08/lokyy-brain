/*
 * Story 11.8 — Web-Share-Target POST-Handler (Service-Worker-Snippet).
 *
 * Wird via `workbox.importScripts` in den von vite-plugin-pwa generierten
 * Service Worker eingezogen. Hintergrund: das PWA-Manifest deklariert
 *   share_target.action = "/share", method = "POST", multipart/form-data.
 * Der Browser schickt den geteilten Inhalt also als POST-Navigation an
 * `/share`. Eine reine SPA kann einen POST-Body NICHT lesen (eine Navigation
 * hat keinen JS-Zugriff auf den Request-Body), und Workbox' navigateFallback
 * greift nur für GET — ohne diesen Handler liefe der POST ins Leere (404).
 *
 * Lösung (Standard-Pattern): den POST hier abfangen, die FormData (Titel/
 * Text/URL + optionale Datei) kurz in einen dedizierten Cache parken und mit
 * 303 auf GET `/share` redirecten. Die SPA (ShareTarget.tsx) liest die
 * geparkte FormData über `/__share_target_payload` wieder aus und postet sie
 * an das bestehende `POST /api/pipes/share`. So bleibt der geteilte Inhalt
 * inklusive Datei erhalten und der Nutzer sieht eine Quittung statt rohem JSON.
 */

const SHARE_CACHE = "lokyy-share-target";
const SHARE_PAYLOAD_URL = "/__share_target_payload";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // POST-Eingang vom Web-Share-Target → FormData parken, dann GET /share.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(
      (async () => {
        try {
          const form = await event.request.formData();
          const file = form.get("file");

          const meta = {
            title: typeof form.get("title") === "string" ? form.get("title") : "",
            text: typeof form.get("text") === "string" ? form.get("text") : "",
            url: typeof form.get("url") === "string" ? form.get("url") : "",
            hasFile: file instanceof File && file.size > 0,
            fileName: file instanceof File ? file.name : "",
            fileType: file instanceof File ? file.type : "",
          };

          const cache = await caches.open(SHARE_CACHE);
          await cache.put(
            SHARE_PAYLOAD_URL,
            new Response(JSON.stringify(meta), {
              headers: { "Content-Type": "application/json" },
            }),
          );
          if (meta.hasFile && file instanceof File) {
            await cache.put(
              SHARE_PAYLOAD_URL + "/file",
              new Response(file, {
                headers: {
                  "Content-Type": file.type || "application/octet-stream",
                  "X-Share-Filename": encodeURIComponent(file.name),
                },
              }),
            );
          }
        } catch {
          // Selbst bei einem Parse-Fehler den Nutzer in die SPA leiten —
          // ShareTarget zeigt dann einen leeren Zustand statt eines 404.
        }
        // 303 → der Browser folgt mit GET; navigateFallback liefert index.html.
        return Response.redirect("/share?from=share-target", 303);
      })(),
    );
    return;
  }

  // GET-Auslese der geparkten Payload — von ShareTarget.tsx aufgerufen.
  if (event.request.method === "GET" && url.pathname === SHARE_PAYLOAD_URL) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHARE_CACHE);
        const hit = await cache.match(SHARE_PAYLOAD_URL);
        return (
          hit ??
          new Response(JSON.stringify({ empty: true }), {
            headers: { "Content-Type": "application/json" },
          })
        );
      })(),
    );
    return;
  }

  // GET der geparkten Datei — von ShareTarget.tsx aufgerufen.
  if (event.request.method === "GET" && url.pathname === SHARE_PAYLOAD_URL + "/file") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHARE_CACHE);
        const hit = await cache.match(SHARE_PAYLOAD_URL + "/file");
        return hit ?? new Response(null, { status: 404 });
      })(),
    );
    return;
  }
});
