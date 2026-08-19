import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

function normalizePath(path: string): string {
  return path
    .replace(/:[A-Za-z0-9_]+/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}");
}

function implementationRoutes(source: string): Set<string> {
  const routes = new Set<string>();
  const pattern = /router\.(get|post|patch|delete|put)\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    routes.add(`${match[1].toUpperCase()} ${normalizePath(match[2])}`);
  }
  return routes;
}

function openapiRoutes(source: string): Set<string> {
  const routes = new Set<string>();
  let currentPath: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const pathMatch = line.match(/^  (\/openai\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (!currentPath) continue;
    const methodMatch = line.match(/^    ([a-z]+):\s*$/);
    if (methodMatch && HTTP_METHODS.has(methodMatch[1])) {
      routes.add(`${methodMatch[1].toUpperCase()} ${normalizePath(currentPath)}`);
    }
  }
  return routes;
}

describe("OpenAPI and Express route contract", () => {
  it("keeps every /openai route represented on both sides", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    const routeSource = readFileSync(
      resolve(repoRoot, "artifacts/api-server/src/routes/openai/index.ts"),
      "utf8",
    );
    const specSource = readFileSync(resolve(repoRoot, "lib/api-spec/openapi.yaml"), "utf8");

    const implementation = implementationRoutes(routeSource);
    const spec = openapiRoutes(specSource);

    expect([...implementation].sort()).toEqual([...spec].sort());
  });
});
