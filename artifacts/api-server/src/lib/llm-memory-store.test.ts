import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  storeMemory,
  recallMemories,
  updateMemory,
  forgetMemory,
  supersedeMemory,
  findRelevantMemories,
  getActiveMemorySummary,
  formatMemoriesForPrompt,
  runMemoryMaintenance,
  closeMemoryStore,
  type StoreMemoryInput,
} from "./llm-memory-store";

const DB_DIR = join(process.cwd(), "data", "llm-memory");
const DB_PATH = join(DB_DIR, "memories.db");

function cleanDb(): void {
  closeMemoryStore();
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

beforeEach(() => {
  cleanDb();
});

afterEach(() => {
  cleanDb();
});

describe("llm-memory-store", () => {
  it("stores and recalls a memory by keyword", () => {
    const entry = storeMemory({
      topic: "TypeScript 5.0の新機能",
      content: "TypeScript 5.0ではconst型パラメータが導入された",
      source_url: "https://example.com/ts5",
      tags: ["typescript", "programming"],
    });

    expect(entry.id).toMatch(/^mem_/);
    expect(entry.topic).toBe("TypeScript 5.0の新機能");
    expect(entry.confidence).toBe(1.0);

    const results = recallMemories("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.topic).toBe("TypeScript 5.0の新機能");
  });

  it("does not return superseded memories in recall", () => {
    const old = storeMemory({
      topic: "古い情報",
      content: "これは古い情報です",
    });
    const fresh = storeMemory({
      topic: "古い情報",
      content: "これは更新された情報です",
    });

    supersedeMemory(old.id, fresh.id);

    const results = recallMemories("古い情報");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(fresh.id);
  });

  it("does not return forgotten memories in recall", () => {
    const entry = storeMemory({
      topic: "不要な情報",
      content: "これは削除されるべき情報",
    });

    forgetMemory(entry.id);

    const results = recallMemories("不要");
    expect(results).toHaveLength(0);
  });

  it("updates memory content", () => {
    const entry = storeMemory({
      topic: "テストトピック",
      content: "元の内容",
    });

    const updated = updateMemory(entry.id, {
      content: "更新された内容",
      confidence: 0.8,
    });

    expect(updated).not.toBeNull();
    expect(updated?.content).toBe("更新された内容");
    expect(updated?.confidence).toBe(0.8);
  });

  it("finds relevant memories for a user message", () => {
    storeMemory({
      topic: "React 19の新機能",
      content: "React 19ではServer Componentsが安定化した",
      tags: ["react", "frontend"],
    });
    storeMemory({
      topic: "天気予報",
      content: "東京の明日の天気は晴れ",
    });

    const relevant = findRelevantMemories("Reactの最新情報を教えて");
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    expect(relevant[0]?.topic).toContain("React");
  });

  it("does not return expired memories", () => {
    storeMemory({
      topic: "期限切れの記憶",
      content: "この情報はもう古い",
      expires_at: "2020-01-01T00:00:00Z",
    });

    const results = recallMemories("期限切れ");
    expect(results).toHaveLength(0);
  });

  it("formats memories for system prompt injection", () => {
    const entry = storeMemory({
      topic: "テスト記憶",
      content: "テストの内容",
      source_url: "https://example.com",
    });

    const formatted = formatMemoriesForPrompt([entry]);
    expect(formatted).toContain("<llm_memory>");
    expect(formatted).toContain("テスト記憶");
    expect(formatted).toContain("テストの内容");
    expect(formatted).toContain("https://example.com");
  });

  it("returns empty string for empty memory list", () => {
    expect(formatMemoriesForPrompt([])).toBe("");
  });

  it("runs maintenance without errors", () => {
    storeMemory({ topic: "テスト", content: "内容" });
    const stats = runMemoryMaintenance();
    expect(stats.totalActive).toBeGreaterThanOrEqual(1);
  });

  it("getActiveMemorySummary returns only active memories", () => {
    const active = storeMemory({ topic: "有効", content: "有効な記憶" });
    const expired = storeMemory({
      topic: "無効",
      content: "期限切れ",
      expires_at: "2020-01-01T00:00:00Z",
    });

    const summary = getActiveMemorySummary();
    const ids = summary.map((m) => m.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(expired.id);
  });
});
