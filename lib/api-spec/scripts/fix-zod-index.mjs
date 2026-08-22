import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(here, "../../api-zod/src/index.ts");

let source = await readFile(indexPath, "utf8");

// Orval appends a broad generated-types barrel export to the workspace index.
// That collides with Zod schema constants carrying the same operation names
// (for example SendOpenaiMessageParams). The hand-maintained explicit type
// export above is intentional; remove only Orval's generated wildcard line.
source = source.replace(
  /^export \* from ['"]\.\/generated\/types['"];?\s*$/gm,
  "",
);
source = source.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

if (!source.includes('export * from "./generated/api";')) {
  throw new Error("api-zod index is missing the generated API export");
}
if (!source.includes("export type {")) {
  throw new Error("api-zod index is missing its collision-free explicit type exports");
}
if (/^export \* from ['"]\.\/generated\/types['"];?\s*$/m.test(source)) {
  throw new Error("unsafe generated-types wildcard export remains in api-zod index");
}

await writeFile(indexPath, source, "utf8");
