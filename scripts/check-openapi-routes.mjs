#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specPath = path.join(root, "lib/api-spec/openapi.yaml");
const routerPath = path.join(root, "artifacts/api-server/src/routes/openai/index.ts");
const methods = new Set(["get", "post", "put", "patch", "delete"]);

function normalizeRoute(route) {
  return route.replace(/:[^/]+/g, "{}").replace(/\{[^/]+\}/g, "{}");
}

function parseSpecRoutes(source) {
  const routes = new Set();
  let inPaths = false;
  let currentPath = null;
  for (const line of source.split(/\r?\n/)) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths && /^components:\s*$/.test(line)) break;
    const pathMatch = line.match(/^  (\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^    ([a-z]+):\s*$/);
    if (currentPath && methodMatch && methods.has(methodMatch[1]) && currentPath.startsWith("/openai/")) {
      routes.add(`${methodMatch[1].toUpperCase()} ${normalizeRoute(currentPath)}`);
    }
  }
  return routes;
}

function parseExpressRoutes(source) {
  const routes = new Set();
  const pattern = /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    routes.add(`${match[1].toUpperCase()} ${normalizeRoute(match[2])}`);
  }
  return routes;
}

const specRoutes = parseSpecRoutes(fs.readFileSync(specPath, "utf8"));
const expressRoutes = parseExpressRoutes(fs.readFileSync(routerPath, "utf8"));
const missingInCode = [...specRoutes].filter((route) => !expressRoutes.has(route)).sort();
const missingInSpec = [...expressRoutes].filter((route) => !specRoutes.has(route)).sort();

if (missingInCode.length || missingInSpec.length) {
  if (missingInCode.length) {
    console.error("OpenAPI only (missing Express implementation):");
    for (const route of missingInCode) console.error(`  ${route}`);
  }
  if (missingInSpec.length) {
    console.error("Express only (missing OpenAPI documentation):");
    for (const route of missingInSpec) console.error(`  ${route}`);
  }
  process.exit(1);
}

console.log(`OpenAPI/Express route contract OK (${specRoutes.size} OpenAI operations).`);
