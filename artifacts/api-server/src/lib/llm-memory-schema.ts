import { z } from "zod";

export const memoryIdSchema = z.string().trim().min(1).max(80);
const dateSchema = z.string().date();
const timestampSchema = z.string().datetime({ offset: true });
const fields = {
  topic: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  kind: z.enum(["user_statement", "sourced_fact", "inference", "unverified"]),
  category: z.enum(["preference", "decision", "progress", "knowledge"]),
  source_url: z
    .string()
    .url()
    .max(2000)
    .refine((url) => /^https?:\/\//i.test(url), "HTTP(S) source required")
    .nullable(),
  source_ref: z.string().trim().min(1).max(200).nullable(),
  valid_as_of: dateSchema.nullable(),
  expires_at: timestampSchema,
  confidence: z.number().finite().min(0).max(1),
  tags: z.array(z.string().trim().min(1).max(50)).max(10),
};

export const memoryStoreSchema = z
  .object({
    ...fields,
    kind: fields.kind.default("unverified"),
    category: fields.category.default("knowledge"),
    source_url: fields.source_url.optional(),
    source_ref: fields.source_ref.optional(),
    valid_as_of: fields.valid_as_of.optional(),
    expires_at: fields.expires_at.optional(),
    confidence: fields.confidence.default(0.5),
    tags: fields.tags.default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expires_at && Date.parse(value.expires_at) <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "expires_at must be in the future",
      });
    }
    if (
      value.kind === "sourced_fact" &&
      (!value.source_url || !value.valid_as_of)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourced_fact requires source_url and valid_as_of",
      });
    }
  });

export const memoryUpdateSchema = z
  .object(fields)
  .partial()
  .extend({
    expected_revision: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "expected_revision" && key !== "reason",
      ),
    "At least one updated field is required",
  );

export const memoryInvalidateSchema = z
  .object({
    reason: z.enum(["incorrect", "unnecessary", "outdated"]),
    expected_revision: z.number().int().positive().optional(),
  })
  .strict();

export type StoreMemoryInput = z.input<typeof memoryStoreSchema>;
export type UpdateMemoryInput = z.input<typeof memoryUpdateSchema>;
