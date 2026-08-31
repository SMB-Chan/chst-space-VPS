/**
 * Form safety classification engine.
 *
 * This module is the core safeguard for web form interaction. It uses a
 * "deny by default" approach: forms are classified as SAFE only when they
 * pass ALL safety checks. Any doubt results in BLOCKED classification.
 *
 * Safety layers:
 * 1. Input type blocklist (password, credit card, file upload, etc.)
 * 2. URL pattern blocklist (payment, login, checkout, etc.)
 * 3. Form structure analysis (field count, method, action)
 * 4. Context signals (surrounding text, form purpose)
 */

export type FormSafetyVerdict = "safe" | "blocked" | "uncertain";

export interface FormSafetyReason {
  rule: string;
  detail: string;
  severity: "critical" | "warning" | "info";
}

export interface FormSafetyResult {
  verdict: FormSafetyVerdict;
  reasons: FormSafetyReason[];
  riskScore: number; // 0 = completely safe, 100 = definitely dangerous
}

export interface FormFieldInfo {
  name: string;
  id: string;
  type: string;
  placeholder: string;
  label: string;
  required: boolean;
  autocomplete: string;
  maxLength: number | null;
}

export interface FormInfo {
  index: number;
  action: string;
  method: string;
  fields: FormFieldInfo[];
  submitText: string;
  surroundingText: string;
  safety: FormSafetyResult;
}

// ---------------------------------------------------------------------------
// Blocklists — these are the hard safety boundaries
// ---------------------------------------------------------------------------

/** Input types that are NEVER safe for automated interaction. */
const BLOCKED_INPUT_TYPES = new Set([
  "password",
  "file",
  "hidden",
  "image",
  "color",
  "range",
]);

/** Autocomplete values that indicate sensitive data collection. */
const BLOCKED_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "cc-number",
  "cc-name",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "gender",
  "national-id",
  "organization-title",
  "photo",
]);

/** URL path patterns that indicate high-risk destinations. */
const BLOCKED_URL_PATTERNS = [
  /login/i,
  /signin/i,
  /sign-in/i,
  /signup/i,
  /sign-up/i,
  /register/i,
  /auth/i,
  /password/i,
  /payment/i,
  /pay(ment)?[/-]/i,
  /checkout/i,
  /cart/i,
  /order/i,
  /purchase/i,
  /billing/i,
  /invoice/i,
  /bank/i,
  /transfer/i,
  /withdraw/i,
  /deposit/i,
  /account[/-]/i,
  /profile[/-]edit/i,
  /settings[/-]/i,
  /delete/i,
  /remove/i,
  /admin/i,
  /dashboard/i,
  /confirm/i,
  /subscribe/i,
  /unsubscribe/i,
  /opt-in/i,
  /opt-out/i,
  /donate/i,
  /tip/i,
];

/** Field name/placeholder patterns that indicate sensitive data. */
const BLOCKED_FIELD_PATTERNS = [
  /password/i,
  /passwd/i,
  /pass_word/i,
  /credit.?card/i,
  /card.?number/i,
  /card.?name/i,
  /cvv/i,
  /cvc/i,
  /csc/i,
  /expir(ation|y)/i,
  /ssn/i,
  /social.?security/i,
  /bank.?account/i,
  /routing.?number/i,
  /pin/i,
  /secret/i,
  /api.?key/i,
  /token/i,
  /private.?key/i,
  /passport/i,
  /license.?number/i,
  /date.?of.?birth/i,
  /dob/i,
  /mother.?s.?maiden/i,
];

/** Form action patterns that indicate state-changing operations. */
const BLOCKED_ACTION_PATTERNS = [
  /\/(api|ajax)\/(create|update|delete|remove|submit|process|execute|modify)/i,
  /\/(graphql)/i,
  /\b(action)=(create|update|delete|remove|submit|process|execute|modify)\b/i,
];

/** Domains known for financial/sensitive operations. */
const BLOCKED_DOMAIN_PATTERNS = [
  /paypal/i,
  /stripe/i,
  /squareup/i,
  /venmo/i,
  /cashapp/i,
  /zelle/i,
  /wise\.com/i,
  /revolut/i,
  /bank/i,
  /creditunion/i,
];

// ---------------------------------------------------------------------------
// Safe form indicators — positive signals for information-retrieval forms
// ---------------------------------------------------------------------------

const SAFE_FORM_INDICATORS = [
  /search/i,
  /query/i,
  /lookup/i,
  /find/i,
  /calculate/i,
  /convert/i,
  /check/i,
  /track/i,
  /zip.?code/i,
  /postal.?code/i,
  /tracking.?number/i,
];

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function isUrlBlocked(url: string): FormSafetyReason | null {
  try {
    const parsed = new URL(url);
    const fullPath = `${parsed.hostname}${parsed.pathname}${parsed.search}`;

    for (const pattern of BLOCKED_URL_PATTERNS) {
      if (pattern.test(fullPath)) {
        return {
          rule: "BLOCKED_URL_PATTERN",
          detail: `URL matches blocked pattern: ${pattern}`,
          severity: "critical",
        };
      }
    }

    for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
      if (pattern.test(parsed.hostname)) {
        return {
          rule: "BLOCKED_DOMAIN",
          detail: `Domain matches blocked pattern: ${pattern}`,
          severity: "critical",
        };
      }
    }
  } catch {
    return {
      rule: "INVALID_URL",
      detail: "Form action URL is not a valid URL",
      severity: "critical",
    };
  }

  return null;
}

function isFieldBlocked(field: FormFieldInfo): FormSafetyReason | null {
  // Check input type
  if (BLOCKED_INPUT_TYPES.has(field.type.toLowerCase())) {
    return {
      rule: "BLOCKED_INPUT_TYPE",
      detail: `Input type "${field.type}" is not allowed`,
      severity: "critical",
    };
  }

  // Check autocomplete
  if (
    field.autocomplete &&
    BLOCKED_AUTOCOMPLETE.has(field.autocomplete.toLowerCase())
  ) {
    return {
      rule: "BLOCKED_AUTOCOMPLETE",
      detail: `Autocomplete "${field.autocomplete}" indicates sensitive data`,
      severity: "critical",
    };
  }

  // Check field name/placeholder/label patterns
  const fieldText = `${field.name} ${field.placeholder} ${field.label}`;
  for (const pattern of BLOCKED_FIELD_PATTERNS) {
    if (pattern.test(fieldText)) {
      return {
        rule: "BLOCKED_FIELD_PATTERN",
        detail: `Field matches sensitive pattern: ${pattern}`,
        severity: "critical",
      };
    }
  }

  return null;
}

function isActionBlocked(action: string): FormSafetyReason | null {
  for (const pattern of BLOCKED_ACTION_PATTERNS) {
    if (pattern.test(action)) {
      return {
        rule: "BLOCKED_ACTION_PATTERN",
        detail: `Form action matches state-changing pattern: ${pattern}`,
        severity: "critical",
      };
    }
  }
  return null;
}

/**
 * Classify a form's safety for automated interaction.
 *
 * Returns a verdict with detailed reasons. A form is SAFE only when:
 * - No blocked input types (password, file, credit card, etc.)
 * - No blocked URL patterns (payment, login, checkout, etc.)
 * - No blocked field names (sensitive data indicators)
 * - No blocked action patterns (state-changing operations)
 * - Field count is reasonable (≤ 3 for search-like forms)
 * - Method is GET or POST to a safe destination
 */
export function classifyFormSafety(
  form: Omit<FormInfo, "safety">,
): FormSafetyResult {
  const reasons: FormSafetyReason[] = [];
  let riskScore = 0;

  // Layer 1: URL safety
  const urlBlock = isUrlBlocked(form.action);
  if (urlBlock) {
    reasons.push(urlBlock);
    riskScore += 100;
  }

  // Layer 2: Action pattern safety
  const actionBlock = isActionBlocked(form.action);
  if (actionBlock) {
    reasons.push(actionBlock);
    riskScore += 80;
  }

  // Layer 3: Field-level safety
  for (const field of form.fields) {
    const fieldBlock = isFieldBlocked(field);
    if (fieldBlock) {
      reasons.push(fieldBlock);
      riskScore += 50;
    }
  }

  // Layer 4: Structure analysis
  const interactiveFields = form.fields.filter(
    (f) =>
      !["hidden", "submit", "button", "reset"].includes(f.type.toLowerCase()),
  );

  if (interactiveFields.length > 3) {
    reasons.push({
      rule: "TOO_MANY_FIELDS",
      detail: `Form has ${interactiveFields.length} interactive fields (max 3 for safe forms)`,
      severity: "warning",
    });
    riskScore += 20;
  }

  // POST method adds slight risk (but is not auto-blocked for search forms)
  if (form.method.toLowerCase() === "post") {
    reasons.push({
      rule: "POST_METHOD",
      detail: "Form uses POST method — verify it does not modify state",
      severity: "warning",
    });
    riskScore += 10;
  }

  // Layer 5: Positive signals (reduce risk score)
  const formContext = `${form.submitText} ${form.surroundingText}`;
  for (const indicator of SAFE_FORM_INDICATORS) {
    if (indicator.test(formContext)) {
      riskScore = Math.max(0, riskScore - 15);
      reasons.push({
        rule: "SAFE_INDICATOR",
        detail: `Form context matches safe indicator: ${indicator}`,
        severity: "info",
      });
      break;
    }
  }

  // Determine verdict
  let verdict: FormSafetyVerdict;
  if (riskScore >= 50) {
    verdict = "blocked";
  } else if (riskScore >= 20) {
    verdict = "uncertain";
  } else {
    verdict = "safe";
  }

  // Hard override: any critical reason blocks the form
  if (reasons.some((r) => r.severity === "critical")) {
    verdict = "blocked";
    riskScore = Math.max(riskScore, 100);
  }

  return { verdict, reasons, riskScore };
}

/**
 * Check if a value is safe to input into a form field.
 * This prevents injection of sensitive data or malicious content.
 */
export function isSafeInputValue(value: string, field: FormFieldInfo): boolean {
  // No secrets
  if (/sk-[A-Za-z0-9_-]{16,}/.test(value)) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false;
  if (/bearer\s+[A-Za-z0-9._-]{16,}/i.test(value)) return false;
  if (/api[_-]?key\s*[:=]\s*\S+/i.test(value)) return false;

  // No email addresses (could be PII)
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;

  // No phone numbers
  if (/^\+?[\d\s()-]{10,}$/.test(value)) return false;

  // Length check
  if (field.maxLength && value.length > field.maxLength) return false;

  // No script injection
  if (/<script/i.test(value)) return false;

  return true;
}

/**
 * Post-submission safety check: verify the result page doesn't
 * request sensitive information (e.g., a login redirect after form submission).
 */
export function isResultPageSafe(
  resultHtml: string,
  resultUrl: string,
): FormSafetyResult {
  const reasons: FormSafetyReason[] = [];
  let riskScore = 0;

  // Check if redirected to a login/payment page
  const urlBlock = isUrlBlocked(resultUrl);
  if (urlBlock) {
    reasons.push({
      ...urlBlock,
      detail: `Result page redirected to blocked URL: ${urlBlock.detail}`,
    });
    riskScore += 100;
  }

  // Check for password fields in the result page
  if (/<input[^>]*type=["']password["']/i.test(resultHtml)) {
    reasons.push({
      rule: "PASSWORD_IN_RESULT",
      detail: "Result page contains a password input field",
      severity: "critical",
    });
    riskScore += 100;
  }

  // Check for credit card fields
  if (/credit.?card|card.?number|cvv|csc/i.test(resultHtml.slice(0, 10_000))) {
    reasons.push({
      rule: "PAYMENT_IN_RESULT",
      detail: "Result page contains payment-related content",
      severity: "critical",
    });
    riskScore += 100;
  }

  const verdict =
    riskScore >= 50 ? "blocked" : riskScore >= 20 ? "uncertain" : "safe";

  return { verdict, reasons, riskScore };
}
