import fs from "node:fs";

const generationFile = "artifacts/api-server/src/lib/file-generation.ts";
const testFile = "artifacts/api-server/src/lib/file-generation.test.ts";

let source = fs.readFileSync(generationFile, "utf8");
const targetSchema = String.raw`"<file_data>\\n" + formatInstructions[format] + "\\n</file_data>",`;
const replacementSchema = String.raw`"<file_data>\n" + formatInstructions[format] + "\n</file_data>",`;
const targetJoin = String.raw`].join("\\n");`;
const replacementJoin = String.raw`].join("\n");`;

const schemaCount = source.split(targetSchema).length - 1;
const joinCount = source.split(targetJoin).length - 1;
if (schemaCount !== 1) {
  throw new Error(`Expected exactly 1 escaped schema newline expression, found ${schemaCount}`);
}
if (joinCount !== 2) {
  throw new Error(`Expected exactly 2 escaped join expressions, found ${joinCount}`);
}
source = source.replace(targetSchema, replacementSchema).replaceAll(targetJoin, replacementJoin);
fs.writeFileSync(generationFile, source);

let tests = fs.readFileSync(testFile, "utf8");
const systemAnchor = '    expect(system).toContain("<file_data>");\n';
const systemInsert = systemAnchor + '    expect(system).toContain("\\nSTRICT RULES:\\n");\n';
const userAnchor = '    expect(user).toContain("<conversation_data>");\n';
const userInsert = userAnchor + '    expect(user).toContain("\\n<conversation_data>\\n");\n';
if (!tests.includes(systemAnchor) || !tests.includes(userAnchor)) {
  throw new Error("Expected prompt trust-boundary test anchors were not found");
}
tests = tests.replace(systemAnchor, systemInsert).replace(userAnchor, userInsert);
fs.writeFileSync(testFile, tests);
