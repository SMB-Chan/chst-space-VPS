export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Dev: skip so Vite HMR is not intercepted. Prod: register the shell worker.
  if (!import.meta.env.PROD) return;

  window.addEventListener("load", () => {
    const baseUrl = import.meta.env.BASE_URL;
    navigator.serviceWorker
      .register(`${baseUrl}sw.js`, { scope: baseUrl })
      .then((reg) => {
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      })
      .catch((error) => {
        console.warn("Service Worker registration failed:", error);
      });
  });
}
