import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";

import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { registerServiceWorker } from "./pwa";

import "./index.css";
import "./design-system/tokens.css";

const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
if (baseUrl) {
  setBaseUrl(baseUrl);
}

registerServiceWorker();

createRoot(document.getElementById("root")!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
