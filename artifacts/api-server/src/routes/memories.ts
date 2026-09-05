import { Router, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  memoryIdSchema,
  memoryStoreSchema,
  memoryUpdateSchema,
  memoryInvalidateSchema,
} from "../lib/llm-memory-schema";
import {
  storeMemory,
  recallMemories,
  findRelevantMemories,
  formatMemoriesForPrompt,
  getMemory,
  getMemoryHistory,
  listMemories,
  updateMemory,
  invalidateMemory,
  supersedeMemory,
  forgetMemory,
  runMemoryMaintenance,
  MemoryConflictError,
} from "../lib/llm-memory-store";

const router = Router();
router.use("/memories", requireAuth);
const handle =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: "Invalid memory request",
          issues: error.issues.map(({ path, message }) => ({
            path,
            message,
          })),
        });
        return;
      }
      if (error instanceof MemoryConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
const paging = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
const search = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();

router.get(
  "/memories",
  handle(async (req, res) => {
    const input = paging.parse(req.query);
    res.json({
      memories: await listMemories(req.userId!, input.limit, input.offset),
    });
  }),
);
router.post(
  "/memories",
  handle(async (req, res) => {
    res
      .status(201)
      .json(await storeMemory(req.userId!, memoryStoreSchema.parse(req.body)));
  }),
);
router.get(
  "/memories/search",
  handle(async (req, res) => {
    const input = search.parse(req.query);
    res.json({
      memories: await recallMemories(req.userId!, input.query, input.limit),
    });
  }),
);
router.post(
  "/memories/context",
  handle(async (req, res) => {
    const input = z
      .object({
        message: z.string().trim().min(1).max(4000),
        max_chars: z.number().int().min(256).max(6000).default(6000),
      })
      .strict()
      .parse(req.body);
    const memories = await findRelevantMemories(req.userId!, input.message, 10);
    const context = formatMemoriesForPrompt(memories, input.max_chars);
    res.json({
      context,
      characters: context.length,
      max_chars: input.max_chars,
    });
  }),
);
router.post(
  "/memories/maintenance",
  handle(async (req, res) => {
    res.json(await runMemoryMaintenance(req.userId!));
  }),
);
router.get(
  "/memories/:id",
  handle(async (req, res) => {
    const memory = await getMemory(
      req.userId!,
      memoryIdSchema.parse(req.params.id),
    );
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(memory);
  }),
);
router.get(
  "/memories/:id/revisions",
  handle(async (req, res) => {
    const id = memoryIdSchema.parse(req.params.id);
    if (!(await getMemory(req.userId!, id))) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ revisions: await getMemoryHistory(req.userId!, id) });
  }),
);
router.patch(
  "/memories/:id",
  handle(async (req, res) => {
    const input = memoryUpdateSchema
      .refine(
        (value) => value.expected_revision !== undefined,
        "expected_revision is required",
      )
      .parse(req.body);
    const memory = await updateMemory(
      req.userId!,
      memoryIdSchema.parse(req.params.id),
      input,
    );
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(memory);
  }),
);
router.post(
  "/memories/:id/invalidate",
  handle(async (req, res) => {
    const input = memoryInvalidateSchema
      .extend({ expected_revision: z.number().int().positive() })
      .parse(req.body);
    const success = await invalidateMemory(
      req.userId!,
      memoryIdSchema.parse(req.params.id),
      input.reason,
      input.expected_revision,
    );
    res
      .status(success ? 200 : 404)
      .json(success ? { invalidated: true } : { error: "Memory not found" });
  }),
);
router.post(
  "/memories/:id/supersede",
  handle(async (req, res) => {
    const { new_id } = z
      .object({ new_id: memoryIdSchema })
      .strict()
      .parse(req.body);
    const success = await supersedeMemory(
      req.userId!,
      memoryIdSchema.parse(req.params.id),
      new_id,
    );
    res
      .status(success ? 200 : 409)
      .json(
        success
          ? { superseded: true }
          : { error: "Both memories must be distinct, owned, and active" },
      );
  }),
);
router.delete(
  "/memories/:id",
  handle(async (req, res) => {
    const success = await forgetMemory(
      req.userId!,
      memoryIdSchema.parse(req.params.id),
    );
    if (!success) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.status(204).end();
  }),
);
export default router;
