import type OpenAI from "openai";
import type { FileFormat } from "./file-generation";
import { matchSkills } from "./skills";
import { splitThinkTags } from "./stream-delta";
import type { CapabilityToolPlan } from "./capability-broker";
import type { SpecialistToolCall } from "./specialist-capabilities";
import { codingModePrompt } from "./coding-mode";
import {
  buildTranslationSystemPrompt,
  type TranslationMode,
} from "./translation";

const DEFAULT_CHAT_SYSTEM_PROMPT = `あなたは高品質なアシスタントです。以下の規則に従ってください。

回答言語:
- 翻訳モード以外の通常会話では、必ず日本語で回答してください。
- ユーザーのメッセージが英語や他の言語であっても、回答は日本語で行ってください。
- 専門用語や固有名詞は原文を括弧内に併記してよい。

出力の規則:
- 箇明瞭で簡潔な回答を心がけてください。
- 根拠のある情報に基づいて回答し、不確かな場合は明示してください。`;

const ARTIFACT_SYSTEM_PROMPT = `ユーザーがダウンロード可能なファイル（Markdown / text / CSV / JSON / HTML）を求めた場合だけ、回答とは別に次の fenced block でファイル内容を出してください。

形式:
\`\`\`artifact filename="example.md" mime="text/markdown"
ファイル本文
\`\`\`

規則:
- 対応するのは md / txt / csv / json / html のみ。PDF・Officeバイナリはこの形式で出さない。
- artifact block は最大3件、各2MBまで。
- artifact block の内容はユーザーに見せる本文ではなく、ダウンロードファイルとして保存される。
- 通常の回答本文には artifact block を残さず、何を作ったかだけ短く書く。`;

const FILE_GENERATION_SYSTEM_PROMPT = `ユーザーが PDF / Word / Excel / PowerPoint ファイルの生成を求めています。システムが自動的にファイルを生成してダウンロードボタンを表示するので、あなたは以下のように答えてください。

- HTML や Markdown のコードブロック、雛形、手順を出力しない。
- 「ユーザー側で作成してください」「ブラウザで印刷してください」「ダウンロードして作成」など、ユーザーに作業を押し付ける指示を出さない。
- 「ファイルを生成できません」などと断らない。システムが必ず生成する。
- 作成するファイルの概要（タイトルや主なセクション）を短く述べ、後はファイルの自動生成に任せる。`;

export function wantsGeneratedFile(userText: string): boolean {
  return /(pdf|docx|xlsx|pptx|word|excel|powerpoint|エクセル|パワーポイント|ワード)/i.test(
    userText,
  );
}

function wantsArtifact(userText: string): boolean {
  return /(ダウンロード|ファイル|保存|書き出し|エクスポート|markdown|md|csv|json|html)/i.test(
    userText,
  );
}

/** Build the initial model context without mutating the caller's history. */
export function prepareInitialChatMessages(args: {
  chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  userText: string;
  translationMode?: TranslationMode;
  requestedFileFormat?: FileFormat | null;
  codingFolder?: string | null;
}): {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  skills: ReturnType<typeof matchSkills>;
} {
  const messages = [...args.chatMessages];
  if (args.translationMode) {
    messages.push({
      role: "system",
      content: buildTranslationSystemPrompt(args.translationMode),
    });
  } else {
    messages.push({
      role: "system",
      content: DEFAULT_CHAT_SYSTEM_PROMPT,
    });
    if (args.codingFolder) {
      messages.push({
        role: "system",
        content: codingModePrompt(args.codingFolder),
      });
    } else {
      if (wantsArtifact(args.userText)) {
        messages.push({ role: "system", content: ARTIFACT_SYSTEM_PROMPT });
      }
      if (wantsGeneratedFile(args.userText) || args.requestedFileFormat) {
        messages.push({
          role: "system",
          content: FILE_GENERATION_SYSTEM_PROMPT,
        });
      }
    }
  }

  const skills =
    args.translationMode || args.codingFolder ? [] : matchSkills(args.userText);
  for (const skill of skills) {
    messages.push({ role: "system", content: skill.prompt });
  }
  return { messages, skills };
}

export function shouldAttachSpecialistTools(args: {
  translationMode?: TranslationMode;
  codingMode?: boolean;
  hasBrokerToolCall: boolean;
  hasWebContext: boolean;
}): boolean {
  return (
    !args.translationMode &&
    !args.codingMode &&
    !args.hasBrokerToolCall &&
    !args.hasWebContext
  );
}

/**
 * Detect a draft that must not be accepted as the completed answer while the
 * server has already attached research tools. This includes both a short
 * "I will search" promise and a false claim that Web/search capabilities are
 * unavailable. The caller gives the turn only one bounded recovery attempt.
 */
export function isResearchAnnouncementOnly(text: string): boolean {
  const normalized = splitThinkTags(text).content.replace(/\s+/g, " ").trim();
  if (!normalized || /\[\d+\]/.test(normalized)) return false;

  const capabilityDenial =
    normalized.length <= 1_200 &&
    (/(?:web|ウェブ|ブラウジング|検索).{0,48}(?:機能|環境|アクセス)?.{0,28}(?:ない|ありません|できない|できません|使えない|利用できない|対応していない)/i.test(
      normalized,
    ) ||
      /(?:リアルタイム|最新(?:の)?情報|今日(?:の)?(?:ニュース|天気)?).{0,64}(?:取得|確認|検索|アクセス).{0,24}(?:できない|できません|行えない|不可)/i.test(
        normalized,
      ) ||
      /(?:ニュースサイト|検索エンジン).{0,48}(?:確認|ご確認)(?:ください|いただく|をお願いします)/i.test(
        normalized,
      ));
  if (capabilityDenial) return true;

  if (normalized.length > 320) return false;
  const announcesResearch =
    /(?:検索|調査|調べ|確認|情報.{0,8}(?:集め|収集)|ウェブ|web\s*search|search|look\s*up|research).{0,100}(?:します|いたします|してみます|行います|使います|呼び出します|始めます|確認します|search|look\s*up|research|check)/i.test(
      normalized,
    ) ||
    /(?:検索|調査|確認).{0,30}(?:してから|した上で).{0,30}(?:回答|まとめ)/.test(
      normalized,
    );
  if (!announcesResearch) return false;
  return !/(?:検索結果|調査結果|によると|判明しました|結論|回答[:：]|出典[:：])/.test(
    normalized,
  );
}

export function shouldSynthesizeResearchAnswer(args: {
  executedToolCount: number;
  continuationText: string;
  hitStepLimitWithPendingResearch: boolean;
}): boolean {
  if (args.executedToolCount <= 0) return false;
  return (
    args.hitStepLimitWithPendingResearch ||
    !args.continuationText.trim() ||
    isResearchAnnouncementOnly(args.continuationText)
  );
}

export function specialistCallFromPlan(
  plan: CapabilityToolPlan,
): SpecialistToolCall | undefined {
  if (plan.tool === "none" || plan.tool === "video.generate") return undefined;
  if (plan.tool === "audio.transcribe") {
    return {
      id: "capability-broker-audio-1",
      name: "transcribe_audio",
      arguments: JSON.stringify({
        attachmentName: plan.attachmentName,
        ...(plan.modelId ? { modelId: plan.modelId } : {}),
        ...(plan.languageHints ? { languageHints: plan.languageHints } : {}),
      }),
    };
  }
  if (plan.tool === "audio.synthesize") {
    return {
      id: "capability-broker-audio-synthesize-1",
      name: "synthesize_speech",
      arguments: JSON.stringify({
        text: plan.text,
        ...(plan.modelId ? { modelId: plan.modelId } : {}),
        ...(plan.voice ? { voice: plan.voice } : {}),
        ...(plan.instruction ? { instruction: plan.instruction } : {}),
        ...(plan.languageHint ? { languageHint: plan.languageHint } : {}),
        ...(plan.rate !== undefined ? { rate: plan.rate } : {}),
        ...(plan.pitch !== undefined ? { pitch: plan.pitch } : {}),
        ...(plan.volume !== undefined ? { volume: plan.volume } : {}),
      }),
    };
  }
  return {
    id: `capability-broker-${plan.tool.replace(".", "-")}-1`,
    name: plan.tool === "image.edit" ? "edit_image" : "generate_image",
    arguments: JSON.stringify({
      prompt: plan.prompt,
      ...(plan.imageName ? { imageName: plan.imageName } : {}),
      ...(plan.modelId ? { modelId: plan.modelId } : {}),
      ...(plan.size ? { size: plan.size.replace("*", "x") } : {}),
      ...(plan.n ? { n: plan.n } : {}),
    }),
  };
}
