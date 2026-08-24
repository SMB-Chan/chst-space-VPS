export const ATTACHMENTS_V1_PREFIX = "CS_ATTACHMENTS_V1:";

export interface SerializableAttachment {
  name: string;
  content: string;
  isBase64: boolean;
  /** Binary documents/audio are base64 but kind "file"; images are "image". */
  kind?: "image" | "file";
}

export type AttachmentChip = { kind: "image" | "file"; name: string };

/**
 * Stable DB/display representation for a user message with attachments.
 * The API request itself sends attachments as structured JSON; this envelope
 * is only used for optimistic UI, private-session history, and persistence.
 */
export function serializeAttachmentMessage(
  question: string,
  attachments: readonly SerializableAttachment[],
): string {
  if (attachments.length === 0) return question;
  return `${ATTACHMENTS_V1_PREFIX}${JSON.stringify({
    question,
    attachments: attachments.map((attachment) => ({
      kind: attachment.kind ?? (attachment.isBase64 ? "image" : "file"),
      name: attachment.name,
      content: attachment.content,
      isBase64: attachment.isBase64,
    })),
  })}`;
}

export function parseAttachmentMessageForDisplay(
  content: string,
): { displayContent: string; attachments: AttachmentChip[] } {
  if (content.startsWith(ATTACHMENTS_V1_PREFIX)) {
    try {
      const parsed = JSON.parse(content.slice(ATTACHMENTS_V1_PREFIX.length)) as {
        question?: unknown;
        attachments?: unknown;
      };
      const displayContent = typeof parsed.question === "string" ? parsed.question : "";
      const raw = Array.isArray(parsed.attachments) ? parsed.attachments : [];
      const attachments = raw.flatMap((item): AttachmentChip[] => {
        if (!item || typeof item !== "object") return [];
        const rec = item as { kind?: unknown; type?: unknown; name?: unknown; isBase64?: unknown };
        if (typeof rec.name !== "string") return [];
        // kind/type があればそれが正（バイナリ文書・音声は base64 でも "file"）。
        // どちらもない旧データだけ isBase64 で推定する。
        const declared = rec.kind ?? rec.type;
        const isImage =
          declared !== undefined ? declared === "image" : rec.isBase64 === true;
        return [{ kind: isImage ? "image" : "file", name: rec.name }];
      });
      return { displayContent, attachments };
    } catch {
      // Never expose a malformed envelope (which may contain megabytes of
      // base64) as ordinary chat text.
      return {
        displayContent: "添付メッセージを表示できませんでした。",
        attachments: [],
      };
    }
  }

  // Legacy single-attachment format.
  const fileMatch = content.match(
    /^\[(File|Image):\s([^\]]+)\]\n\n(.*?)\n\n---\n\nUser question:\s(.*)$/s,
  );
  if (fileMatch) {
    return {
      displayContent: fileMatch[4],
      attachments: [{ kind: fileMatch[1] === "Image" ? "image" : "file", name: fileMatch[2] }],
    };
  }

  return { displayContent: content, attachments: [] };
}
/**
 * Private-session history is posted back by the browser on every turn. Do not
 * resend embedded base64/text payloads indefinitely; retain the question and
 * attachment names while making the omission explicit to the model.
 */
export function compactAttachmentMessageForHistory(content: string): string {
  const parsed = parseAttachmentMessageForDisplay(content);
  if (parsed.attachments.length === 0) return parsed.displayContent;
  const names = parsed.attachments.map((attachment) => attachment.name).join("、");
  return `${parsed.displayContent || "以前の添付についての質問"}

（以前の添付 ${names} は、このターンでは再送されていません。）`;
}

