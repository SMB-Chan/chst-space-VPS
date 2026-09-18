import { useState, type FormEvent } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { useLocation } from "wouter";
import { loadSettings } from "@/lib/settings";
import { useAvailableModels } from "@/components/chat/model-selector";
import { formatModelChipLabel } from "./model-settings-sheet";

const PENDING_SEND_KEY = "chat-space.mobile.pending-send";

function requestModelSheet() {
  window.dispatchEvent(new CustomEvent("mobile-open-model-sheet"));
}

export function writePendingSend(text: string) {
  try {
    sessionStorage.setItem(PENDING_SEND_KEY, text);
  } catch {
    /* ignore */
  }
}

export function consumePendingSend(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_SEND_KEY);
    if (value) sessionStorage.removeItem(PENDING_SEND_KEY);
    return value;
  } catch {
    return null;
  }
}

/**
 * Dedicated composer for the Work tab.
 * Does not mount the chat page underneath — typing sends into a new chat session.
 */
export function WorkComposerDock() {
  const [, setLocation] = useLocation();
  const [text, setText] = useState("");
  const settings = loadSettings();
  const models = useAvailableModels();
  const modelLabel =
    models.find((m) => m.id === settings.defaultModel)?.label ??
    settings.defaultModel;
  const chip = formatModelChipLabel(modelLabel, settings.defaultReasoning);

  const goChat = (payload?: string) => {
    const value = (payload ?? text).trim();
    if (value) writePendingSend(value);
    setLocation("/chat");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    goChat();
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mx-3 mb-[calc(10px+env(safe-area-inset-bottom,0px))] shrink-0 rounded-[24px] border border-[var(--m3-outline-variant)] bg-[var(--mx-panel)] shadow-[var(--m3-elevation-2)]"
      data-testid="work-composer-dock"
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          /* stay on Work until send — layout must remain stable */
        }}
        placeholder="メッセージを入力"
        className="w-full bg-transparent px-4 pb-1 pt-3.5 text-[15px] text-[var(--mx-ink)] outline-none placeholder:text-[var(--mx-ink-dim)]"
        data-testid="work-composer-input"
      />
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <button
          type="button"
          className="mobile-plus-btn"
          aria-label="チャットへ移動して添付"
          onClick={() => goChat()}
        >
          <Plus className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="mobile-model-chip !ml-0 max-w-[50%]"
          onClick={() => requestModelSheet()}
          data-testid="work-model-chip"
        >
          <span>{chip}</span>
        </button>
        <button
          type="button"
          className="ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container-high)]"
          onClick={() => setLocation("/files")}
        >
          <FolderOpen className="h-4 w-4" />
          ファイル
        </button>
        <button
          type="submit"
          className="mobile-send-btn"
          data-ready={text.trim().length > 0}
          disabled={!text.trim()}
          aria-label="チャットで送信"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 19V5M12 5l-6 6M12 5l6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}
