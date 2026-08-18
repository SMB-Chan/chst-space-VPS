import assert from "node:assert/strict";

function mergeStreamDelta(acc, delta) {
  if (!delta) return acc;
  if (!acc) return delta;
  if (delta === acc) return acc;
  if (delta.startsWith(acc)) return delta;
  if (acc.startsWith(delta)) return acc;
  return acc + delta;
}

function splitThinkTags(text) {
  const blocks = [];
  const content = text
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner) => {
      const trimmed = inner.trim();
      if (trimmed) blocks.push(trimmed);
      return "";
    })
    .replace(/^\s+/, "");
  return { reasoning: blocks.join("\n\n"), content };
}

assert.equal(mergeStreamDelta("", "Hello"), "Hello");
assert.equal(mergeStreamDelta("Hello", " world"), "Hello world");
assert.equal(mergeStreamDelta("Hello", "Hello world"), "Hello world");
assert.equal(mergeStreamDelta("Hello world", "Hello world"), "Hello world");
assert.equal(mergeStreamDelta("Hello world", "Hello"), "Hello world");

const split = splitThinkTags("<think>plan</think>\n\nAnswer here");
assert.equal(split.reasoning, "plan");
assert.equal(split.content, "Answer here");

console.log("stream-delta tests ok");
