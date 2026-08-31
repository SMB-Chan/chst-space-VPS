import { describe, expect, it } from "vitest";
import {
  classifyFormSafety,
  isSafeInputValue,
  isResultPageSafe,
  type FormInfo,
} from "./form-safety";

function makeForm(
  overrides: Partial<Omit<FormInfo, "safety">> = {},
): Omit<FormInfo, "safety"> {
  return {
    index: 0,
    action: "https://example.com/search",
    method: "GET",
    fields: [
      {
        name: "q",
        id: "search-input",
        type: "text",
        placeholder: "Search...",
        label: "Search",
        required: false,
        autocomplete: "",
        maxLength: 200,
      },
    ],
    submitText: "Search",
    surroundingText: "Search our site",
    ...overrides,
  };
}

describe("classifyFormSafety", () => {
  it("classifies a simple search form as safe", () => {
    const form = makeForm();
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("safe");
    expect(result.riskScore).toBeLessThan(20);
  });

  it("blocks forms with password fields", () => {
    const form = makeForm({
      fields: [
        {
          name: "username",
          id: "user",
          type: "text",
          placeholder: "",
          label: "Username",
          required: true,
          autocomplete: "",
          maxLength: 100,
        },
        {
          name: "password",
          id: "pass",
          type: "password",
          placeholder: "",
          label: "Password",
          required: true,
          autocomplete: "current-password",
          maxLength: 100,
        },
      ],
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.rule === "BLOCKED_INPUT_TYPE")).toBe(
      true,
    );
  });

  it("blocks forms with credit card fields", () => {
    const form = makeForm({
      fields: [
        {
          name: "card_number",
          id: "cc",
          type: "text",
          placeholder: "Card number",
          label: "Credit Card Number",
          required: true,
          autocomplete: "cc-number",
          maxLength: 20,
        },
      ],
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });

  it("blocks forms pointing to login URLs", () => {
    const form = makeForm({
      action: "https://example.com/login/submit",
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });

  it("blocks forms pointing to payment URLs", () => {
    const form = makeForm({
      action: "https://shop.example.com/checkout/payment",
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });

  it("blocks forms with file upload fields", () => {
    const form = makeForm({
      fields: [
        {
          name: "document",
          id: "file",
          type: "file",
          placeholder: "",
          label: "Upload document",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
      ],
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });

  it("marks forms with many fields as uncertain", () => {
    const form = makeForm({
      surroundingText: "Register your details",
      submitText: "Submit",
      fields: [
        {
          name: "a",
          id: "a",
          type: "text",
          placeholder: "",
          label: "A",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
        {
          name: "b",
          id: "b",
          type: "text",
          placeholder: "",
          label: "B",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
        {
          name: "c",
          id: "c",
          type: "text",
          placeholder: "",
          label: "C",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
        {
          name: "d",
          id: "d",
          type: "text",
          placeholder: "",
          label: "D",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
        {
          name: "e",
          id: "e",
          type: "text",
          placeholder: "",
          label: "E",
          required: false,
          autocomplete: "",
          maxLength: null,
        },
      ],
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).not.toBe("safe");
    expect(result.reasons.some((r) => r.rule === "TOO_MANY_FIELDS")).toBe(true);
  });

  it("blocks forms with state-changing action patterns", () => {
    const form = makeForm({
      action: "https://api.example.com/api/delete",
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });

  it("blocks forms on financial domains", () => {
    const form = makeForm({
      action: "https://www.paypal.com/transfer",
    });
    const result = classifyFormSafety(form);
    expect(result.verdict).toBe("blocked");
  });
});

describe("isSafeInputValue", () => {
  const defaultField = {
    name: "q",
    id: "q",
    type: "text",
    placeholder: "",
    label: "",
    required: false,
    autocomplete: "",
    maxLength: 500,
  };

  it("allows normal search queries", () => {
    expect(isSafeInputValue("東京 天気", defaultField)).toBe(true);
    expect(isSafeInputValue("TypeScript 5.0 features", defaultField)).toBe(
      true,
    );
  });

  it("blocks API keys and secrets", () => {
    expect(
      isSafeInputValue("sk-abc123def456ghi789jkl012mno345", defaultField),
    ).toBe(false);
    expect(
      isSafeInputValue("-----BEGIN RSA PRIVATE KEY-----", defaultField),
    ).toBe(false);
  });

  it("blocks email addresses", () => {
    expect(isSafeInputValue("user@example.com", defaultField)).toBe(false);
  });

  it("blocks phone numbers", () => {
    expect(isSafeInputValue("+81-90-1234-5678", defaultField)).toBe(false);
  });

  it("blocks script injection", () => {
    expect(isSafeInputValue("<script>alert(1)</script>", defaultField)).toBe(
      false,
    );
  });
});

describe("isResultPageSafe", () => {
  it("allows safe result pages", () => {
    const result = isResultPageSafe(
      "<html><body><h1>Search Results</h1><p>Some results here</p></body></html>",
      "https://example.com/results?q=test",
    );
    expect(result.verdict).toBe("safe");
  });

  it("blocks result pages with password fields", () => {
    const result = isResultPageSafe(
      '<html><body><form><input type="password" name="pass"></form></body></html>',
      "https://example.com/login",
    );
    expect(result.verdict).toBe("blocked");
  });

  it("blocks result pages redirected to payment URLs", () => {
    const result = isResultPageSafe(
      "<html><body>Checkout</body></html>",
      "https://shop.example.com/checkout/payment",
    );
    expect(result.verdict).toBe("blocked");
  });
});
