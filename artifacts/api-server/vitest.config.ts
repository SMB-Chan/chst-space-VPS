import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://example.test/v1",
      AI_INTEGRATIONS_OPENAI_API_KEY: "test",
      // A deployment's freeze flags must not decide what a unit test can see;
      // tests that exercise freezing stub these themselves.
      DISABLE_OPENAI_MODELS: "false",
      DISABLE_DASHSCOPE_MODELS: "false",
      DISABLE_XIAOMI_MODELS: "false",
    },
  },
});
