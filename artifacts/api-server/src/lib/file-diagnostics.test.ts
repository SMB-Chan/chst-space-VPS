import { describe, expect, it } from "vitest";
import { getFileGenerationErrorDetails } from "./file-diagnostics";

describe("getFileGenerationErrorDetails", () => {
  it("omits arbitrary error text and database parameters", () => {
    const binaryLikeValue = "A".repeat(500);
    const shortPrivateContent = "Confidential launch plan for Project Maple";
    const error = new Error(
      `Database insert failed for: ${shortPrivateContent} ${binaryLikeValue}`,
    );
    Object.assign(error, {
      code: "DB_INSERT_FAILED",
      queryParameters: [binaryLikeValue],
    });

    const details = getFileGenerationErrorDetails(error);
    expect(details.name).toBe("Error");
    expect(details.code).toBe("DB_INSERT_FAILED");
    expect(details.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(details).not.toHaveProperty("message");
    expect(details).not.toHaveProperty("stack");
    expect(JSON.stringify(details)).not.toContain(shortPrivateContent);
    expect(JSON.stringify(details)).not.toContain(binaryLikeValue);
    expect(details).not.toHaveProperty("queryParameters");
  });

  it("preserves safe external-command diagnostics", () => {
    const error = new Error("pdftocairo exited with 1");
    Object.assign(error, {
      name: "ExternalCommandError",
      command: "pdftocairo",
      commandArgs: ["-png", "preview.pdf"],
      exitCode: 1,
      stderr: "Syntax Error: Document stream is empty",
    });

    expect(getFileGenerationErrorDetails(error)).toMatchObject({
      command: "pdftocairo",
      commandArgs: ["-png", "preview.pdf"],
      exitCode: 1,
      stderr: "Syntax Error: Document stream is empty",
    });
  });

  it("redacts common credential patterns from error messages and stacks", () => {
    const error = new Error(
      "Provider failed with Authorization: Bearer test-token-value and api_key=secret-value",
    );
    const serialized = JSON.stringify(getFileGenerationErrorDetails(error));

    expect(serialized).not.toContain("test-token-value");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("Provider failed");
  });
});