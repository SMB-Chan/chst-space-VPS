import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "artifacts/api-server/vitest.config.ts",
      "artifacts/ai-chat-space/vitest.config.ts",
    ],
  },
});
