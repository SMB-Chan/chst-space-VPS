import { Component, memo, type ReactNode } from "react";
import { Markdown } from "./markdown";

interface SafeMarkdownProps {
  content: string;
  className?: string;
  citationScope: string;
  streaming?: boolean;
}

interface SafeMarkdownState {
  hasError: boolean;
}

/**
 * Error boundary that catches crashes inside the Markdown renderer and falls
 * back to plain-text display. This prevents one malformed assistant message
 * from taking down the entire chat session.
 */
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; content: string },
  SafeMarkdownState
> {
  state: SafeMarkdownState = { hasError: false };

  static getDerivedStateFromError(): SafeMarkdownState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(
      "Markdown rendering failed; falling back to plain text:",
      error,
    );
  }

  componentDidUpdate(prevProps: {
    children: ReactNode;
    content: string;
  }): void {
    if (this.state.hasError && prevProps.content !== this.props.content) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="whitespace-pre-wrap font-mono text-sm text-foreground/90">
          {this.props.content}
        </div>
      );
    }
    return this.props.children;
  }
}

function SafeMarkdownComponent({
  content,
  className,
  citationScope,
  streaming = false,
}: SafeMarkdownProps) {
  return (
    <MarkdownErrorBoundary content={content}>
      <Markdown
        content={content}
        className={className}
        citationScope={citationScope}
        streaming={streaming}
      />
    </MarkdownErrorBoundary>
  );
}

export const SafeMarkdown = memo(SafeMarkdownComponent);
