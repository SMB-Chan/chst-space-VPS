import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://example.test/v1",
      AI_INTEGRATIONS_OPENAI_API_KEY: "test",
    },
  },
});
