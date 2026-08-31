import {
  classifyFormSafety,
  isResultPageSafe,
  isSafeInputValue,
  type FormInfo,
  type FormFieldInfo,
  type FormSafetyResult,
} from "./form-safety";
import {
  fetchWithBrowser,
  getBrowser,
  getBrowserContextOptions,
  installRequestGuard,
} from "./render-fetch";
import { logger, safeFailureFields } from "./logger";

export interface ExtractedForm {
  index: number;
  action: string;
  method: string;
  fields: {
    name: string;
    id: string;
    type: string;
    placeholder: string;
    label: string;
    required: boolean;
  }[];
  submitText: string;
  safety: FormSafetyResult;
}

export interface FormFillResult {
  success: boolean;
  resultText: string;
  resultUrl: string;
  safety: FormSafetyResult;
}

/**
 * Extract all forms from a page using Playwright.
 * Returns form metadata with safety classification.
 */
export async function extractFormsFromPage(
  url: string,
  timeoutMs = 15_000,
): Promise<ExtractedForm[]> {
  return extractFormsViaBrowser(url, timeoutMs);
}

async function extractFormsViaBrowser(
  url: string,
  timeoutMs: number,
): Promise<ExtractedForm[]> {
  try {
    // Use the shared browser infrastructure
    const browser = await getBrowser();
    const context = await browser.newContext(getBrowserContextOptions());

    try {
      await installRequestGuard(context);
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      if (!response || !response.ok()) {
        logger.warn(
          {
            component: "form-fill",
            errorCode: "FORM_PAGE_LOAD_FAILED",
            status: response?.status(),
          },
          "Failed to load page for form extraction",
        );
        return [];
      }

      // Wait for forms to be present
      await page
        .waitForSelector("form", { timeout: 5_000 })
        .catch(() => undefined);

      // Extract form metadata
      const forms = await page.evaluate(() => {
        const doc = document;
        const formElements = doc.querySelectorAll("form");
        const results: {
          index: number;
          action: string;
          method: string;
          fields: {
            name: string;
            id: string;
            type: string;
            placeholder: string;
            label: string;
            required: boolean;
            autocomplete: string;
            maxLength: number | null;
          }[];
          submitText: string;
        }[] = [];

        formElements.forEach((form, index) => {
          const fields: {
            name: string;
            id: string;
            type: string;
            placeholder: string;
            label: string;
            required: boolean;
            autocomplete: string;
            maxLength: number | null;
          }[] = [];

          // Extract input fields
          form.querySelectorAll("input, select, textarea").forEach((el) => {
            const input = el as HTMLInputElement;
            const label =
              input.getAttribute("aria-label") ??
              doc.querySelector(`label[for="${input.id}"]`)?.textContent ??
              input.getAttribute("name") ??
              "";

            fields.push({
              name: input.getAttribute("name") ?? "",
              id: input.id ?? "",
              type:
                input.getAttribute("type") ??
                (el.tagName.toLowerCase() === "select"
                  ? "select"
                  : el.tagName.toLowerCase() === "textarea"
                    ? "textarea"
                    : "text"),
              placeholder: input.getAttribute("placeholder") ?? "",
              label: label.trim(),
              required: input.required,
              autocomplete: input.getAttribute("autocomplete") ?? "",
              maxLength: input.maxLength > 0 ? input.maxLength : null,
            });
          });

          // Find submit button text
          const submitBtn =
            form.querySelector('button[type="submit"], input[type="submit"]') ??
            form.querySelector("button");
          const submitText =
            submitBtn?.textContent?.trim() ??
            (submitBtn as HTMLInputElement)?.value ??
            "Submit";

          const action = form.action || window.location.href;
          const method = form.method || "GET";

          results.push({
            index,
            action,
            method: method.toUpperCase(),
            fields,
            submitText,
          });
        });

        return results;
      });

      // Classify safety for each form
      const extracted: ExtractedForm[] = forms.map((form) => {
        const formInfo: Omit<FormInfo, "safety"> = {
          ...form,
          surroundingText: "",
        } as Omit<FormInfo, "safety">;
        const safety = classifyFormSafety(formInfo);
        return { ...form, safety };
      });

      return extracted;
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    logger.warn(
      safeFailureFields(err, "form-fill", "FORM_EXTRACTION_FAILED"),
      "Form extraction failed",
    );
    return [];
  }
}

/**
 * Fill and submit a form on a page using Playwright.
 * Only operates on forms classified as SAFE.
 *
 * Safety guarantees:
 * - Form must be pre-classified as safe
 * - Each input value is validated against safety rules
 * - Post-submission result page is checked for safety
 * - Maximum wait time for result page
 */
export async function fillAndSubmitForm(
  url: string,
  formIndex: number,
  fieldValues: Record<string, string>,
  timeoutMs = 20_000,
): Promise<FormFillResult> {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext(getBrowserContextOptions());

    try {
      await installRequestGuard(context);
      const page = await context.newPage();

      // Navigate to the form page
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      if (!response || !response.ok()) {
        return {
          success: false,
          resultText: "",
          resultUrl: url,
          safety: {
            verdict: "blocked",
            reasons: [
              {
                rule: "PAGE_LOAD_FAILED",
                detail: `Page returned status ${response?.status()}`,
                severity: "critical",
              },
            ],
            riskScore: 100,
          },
        };
      }

      // Wait for forms
      await page
        .waitForSelector("form", { timeout: 5_000 })
        .catch(() => undefined);

      // Get all forms and validate the target form
      const forms = await page.$$("form");
      if (formIndex >= forms.length) {
        return {
          success: false,
          resultText: "",
          resultUrl: url,
          safety: {
            verdict: "blocked",
            reasons: [
              {
                rule: "FORM_INDEX_OUT_OF_RANGE",
                detail: `Form index ${formIndex} not found (page has ${forms.length} forms)`,
                severity: "critical",
              },
            ],
            riskScore: 100,
          },
        };
      }

      const targetForm = forms[formIndex]!;

      // Re-classify the form safety at fill time (defense in depth)
      const formMeta = await targetForm.evaluate((form) => {
        const fields: FormFieldInfo[] = [];
        form.querySelectorAll("input, select, textarea").forEach((el) => {
          const input = el as HTMLInputElement;
          fields.push({
            name: input.getAttribute("name") ?? "",
            id: input.id ?? "",
            type:
              input.getAttribute("type") ??
              (el.tagName.toLowerCase() === "select" ? "select" : "textarea"),
            placeholder: input.getAttribute("placeholder") ?? "",
            label:
              input.getAttribute("aria-label") ??
              document.querySelector(`label[for="${input.id}"]`)?.textContent ??
              "",
            required: input.required,
            autocomplete: input.getAttribute("autocomplete") ?? "",
            maxLength: input.maxLength > 0 ? input.maxLength : null,
          });
        });
        return {
          index: formIndex,
          action: form.action || window.location.href,
          method: (form.method || "GET").toUpperCase(),
          fields,
          submitText:
            (
              form.querySelector(
                'button[type="submit"], input[type="submit"]',
              ) as HTMLButtonElement
            )?.textContent?.trim() ?? "Submit",
          surroundingText: "",
        };
      });

      const safetyCheck = classifyFormSafety(formMeta);
      if (safetyCheck.verdict !== "safe") {
        return {
          success: false,
          resultText: "",
          resultUrl: url,
          safety: safetyCheck,
        };
      }

      // Fill in each field value with safety validation
      for (const [fieldName, value] of Object.entries(fieldValues)) {
        const field = formMeta.fields.find(
          (f) => f.name === fieldName || f.id === fieldName,
        );
        if (!field) continue;

        // Validate the input value
        if (!isSafeInputValue(value, field)) {
          return {
            success: false,
            resultText: "",
            resultUrl: url,
            safety: {
              verdict: "blocked",
              reasons: [
                {
                  rule: "UNSAFE_INPUT_VALUE",
                  detail: `Input value for "${fieldName}" failed safety check`,
                  severity: "critical",
                },
              ],
              riskScore: 100,
            },
          };
        }

        // Fill the field
        const selector = field.id
          ? `#${CSS.escape(field.id)}`
          : `[name="${CSS.escape(fieldName)}"]`;
        await page.fill(selector, value).catch(() => undefined);
      }

      // Submit the form
      await Promise.all([
        page.waitForNavigation({ timeout: timeoutMs }).catch(() => undefined),
        targetForm.evaluate((form: HTMLFormElement) => form.submit()),
      ]);

      // Wait for result page to settle
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => undefined);

      const resultUrl = page.url();
      const resultHtml = await page.content();

      // Post-submission safety check
      const resultSafety = isResultPageSafe(resultHtml, resultUrl);
      if (resultSafety.verdict !== "safe") {
        return {
          success: false,
          resultText: "",
          resultUrl,
          safety: resultSafety,
        };
      }

      // Extract result text
      const resultText = await page.evaluate(() => {
        const semantic =
          document.querySelector("article") ??
          document.querySelector("main") ??
          document.body;
        return semantic?.innerText?.trim().slice(0, 5000) ?? "";
      });

      return {
        success: true,
        resultText,
        resultUrl,
        safety: resultSafety,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    logger.warn(
      safeFailureFields(err, "form-fill", "FORM_FILL_FAILED"),
      "Form fill and submit failed",
    );
    return {
      success: false,
      resultText: "",
      resultUrl: url,
      safety: {
        verdict: "blocked",
        reasons: [
          {
            rule: "FORM_FILL_ERROR",
            detail:
              err instanceof Error ? err.message : "Unknown form fill error",
            severity: "critical",
          },
        ],
        riskScore: 100,
      },
    };
  }
}
