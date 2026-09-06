import {
  Component,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Markdown } from "./markdown";

interface SafeMarkdownProps {
  content: string;
  className?: string;
  citationScope: string;
}

interface SafeMarkdownState {
  hasError: boolean;
}

const STREAM_RENDER_INTERVAL_MS = 40;

function useBatchedMarkdownContent(content: string): string {
  const [renderedContent, setRenderedContent] = useState(content);
  const renderedRef = useRef(content);
  const latestRef = useRef(content);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = content;

    const current = renderedRef.current;
    if (content === current) return;

    // Replacements, resets and audit patches must be reflected immediately.
    // Only append-only token streaming is coalesced.
    if (!content.startsWith(current)) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      renderedRef.current = content;
      setRenderedContent(content);
      return;
    }

    if (timerRef.current !== null) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const next = latestRef.current;
      renderedRef.current = next;
      setRenderedContent(next);
    }, STREAM_RENDER_INTERVAL_MS);
  }, [content]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return renderedContent;
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
}: SafeMarkdownProps) {
  const renderedContent = useBatchedMarkdownContent(content);

  return (
    <MarkdownErrorBoundary content={renderedContent}>
      <Markdown
        content={renderedContent}
        className={className}
        citationScope={citationScope}
      />
    </MarkdownErrorBoundary>
  );
}

export const SafeMarkdown = memo(SafeMarkdownComponent);
