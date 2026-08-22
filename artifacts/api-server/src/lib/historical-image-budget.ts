import {
  modelContentFor,
  type ModelContentPart,
  type ParsedUserMessageContent,
} from "./message-content";

/**
 * Historical images are optional context. Keep the replay budget fixed so a
 * long-lived image-heavy conversation cannot grow the next model request
 * without bound. The current user message is not charged against this budget.
 */
export const MAX_HISTORICAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_HISTORICAL_IMAGE_COUNT = 4;

export interface HistoricalImageBudget {
  remainingBytes: number;
  remainingImages: number;
}

export function createHistoricalImageBudget(): HistoricalImageBudget {
  return {
    remainingBytes: MAX_HISTORICAL_IMAGE_BYTES,
    remainingImages: MAX_HISTORICAL_IMAGE_COUNT,
  };
}

function omissionNotice(names: string[]): string {
  return `（過去の画像添付 ${names.join("、")} は、会話履歴の画像再送上限のため省略されました。）`;
}

/**
 * Build model content for one historical user message and consume a shared
 * replay budget. Call this while walking history from newest to oldest so the
 * most recent images are retained first.
 */
export function modelContentForHistorical(
  parsed: ParsedUserMessageContent,
  includeImages: boolean,
  budget: HistoricalImageBudget,
): string | ModelContentPart[] {
  if (parsed.images.length === 0 || !includeImages) {
    return modelContentFor(parsed, includeImages);
  }

  budget.remainingBytes = Math.max(0, Math.floor(budget.remainingBytes));
  budget.remainingImages = Math.max(0, Math.floor(budget.remainingImages));

  const included = [] as typeof parsed.images;
  const omitted = [] as typeof parsed.images;

  for (const image of parsed.images) {
    if (budget.remainingImages > 0 && image.bytes <= budget.remainingBytes) {
      included.push(image);
      budget.remainingBytes -= image.bytes;
      budget.remainingImages -= 1;
    } else {
      omitted.push(image);
    }
  }

  if (included.length === 0) {
    return `${parsed.modelText}\n\n${omissionNotice(omitted.map((image) => image.name))}`;
  }

  const parts: ModelContentPart[] = [{ type: "text", text: parsed.modelText }];
  for (const image of included) {
    parts.push({ type: "text", text: `添付画像: ${image.name}` });
    parts.push({ type: "image_url", image_url: { url: image.content } });
  }
  if (omitted.length > 0) {
    parts.push({
      type: "text",
      text: omissionNotice(omitted.map((image) => image.name)),
    });
  }
  return parts;
}
