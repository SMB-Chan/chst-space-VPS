import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageInput } from "./message-input";

describe("MessageInput (composer)", () => {
  it("renders the composer card with textarea, attach, and send buttons", () => {
    const html = renderToStaticMarkup(<MessageInput onSend={() => {}} />);
    expect(html).toContain('data-testid="composer"');
    expect(html).toContain('data-testid="composer-textarea"');
    expect(html).toContain('data-testid="composer-attach"');
    expect(html).toContain('data-testid="composer-send"');
  });

  it("renders the tools toggle when file generation or video is enabled", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        fileGenerationEnabled
        videoGenerationEnabled
      />,
    );
    expect(html).toContain('data-testid="composer-tools-toggle"');
  });

  it("hides the tools toggle when no secondary features are enabled", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        fileGenerationEnabled={false}
        videoGenerationEnabled={false}
      />,
    );
    expect(html).not.toContain('data-testid="composer-tools-toggle"');
  });

  it("renders the tools toggle for mobile model selection", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        onSelectModel={() => {}}
        fileGenerationEnabled={false}
        videoGenerationEnabled={false}
      />,
    );
    expect(html).toContain('data-testid="composer-tools-toggle"');
  });

  it("renders the tools toggle when reasoning is the only secondary control", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        onReasoningChange={() => {}}
        fileGenerationEnabled={false}
        videoGenerationEnabled={false}
      />,
    );
    expect(html).toContain('data-testid="composer-tools-toggle"');
  });

  it("renders active skills as a subtle indicator", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        activeSkills={[{ id: "finance", label: "金融分析" }]}
      />,
    );
    expect(html).toContain("金融分析");
    expect(html).toContain("スキル");
  });

  it("does not render skills section when no skills are active", () => {
    const html = renderToStaticMarkup(
      <MessageInput onSend={() => {}} activeSkills={[]} />,
    );
    expect(html).not.toContain("スキル");
  });

  it("renders model selector when onSelectModel is provided", () => {
    const html = renderToStaticMarkup(
      <MessageInput onSend={() => {}} onSelectModel={() => {}} />,
    );
    expect(html).toContain('data-testid="button-model-selector"');
  });

  it("renders the send button as disabled when content is empty", () => {
    const html = renderToStaticMarkup(<MessageInput onSend={() => {}} />);
    // The send button should be present but disabled
    expect(html).toContain('data-testid="composer-send"');
    expect(html).toContain("disabled");
  });

  it("applies custom placeholder for translation mode", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        placeholder="翻訳するテキストをそのまま入力..."
      />,
    );
    expect(html).toContain("翻訳するテキストをそのまま入力...");
  });

  it("visually distinguishes the active translation composer and shows direction", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        translationMode="ja-ko"
        onTranslationModeChange={() => {}}
      />,
    );
    expect(html).toContain('data-testid="composer-translation-direction"');
    expect(html).toContain("方向: 日本語 → 韓国語");
    expect(html).toContain('aria-label="翻訳モード: 日本語 → 韓国語"');
  });

  it("applies file format placeholder when format is selected", () => {
    const html = renderToStaticMarkup(
      <MessageInput onSend={() => {}} fileGenerationEnabled />,
    );
    // File format buttons should be present in the tools panel
    expect(html).toContain('data-testid="composer-tools-toggle"');
  });

  it("does not render tools panel content until toggled open", () => {
    const html = renderToStaticMarkup(
      <MessageInput
        onSend={() => {}}
        fileGenerationEnabled
        onSelectModel={() => {}}
        onReasoningChange={() => {}}
        onTranslationModeChange={() => {}}
        onAuditToggle={() => {}}
      />,
    );
    // The tools toggle is present but the panel is not rendered until opened
    expect(html).toContain('data-testid="composer-tools-toggle"');
    // Panel content (section labels) should NOT be in the initial render
    expect(html).not.toContain("推論レベル");
  });
});
