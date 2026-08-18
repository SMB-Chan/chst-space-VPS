import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
