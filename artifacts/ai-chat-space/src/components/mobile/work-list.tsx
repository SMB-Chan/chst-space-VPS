import { MonitorSmartphone, MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";
import { GithubMark } from "./github-mark";

export interface WorkItem {
  id: number | string;
  title: string;
  href?: string;
  kind?: "github" | "device" | "chat";
}

interface WorkListProps {
  items: WorkItem[];
  activeHref?: string | null;
  onSelect: (item: WorkItem) => void;
  emptyLabel?: string;
}

function iconFor(item: WorkItem): ReactNode {
  const kind =
    item.kind ??
    (/github|git|vps|deploy|raw|prototype|repo/i.test(item.title)
      ? "github"
      : /image|auth|tool|device|pc/i.test(item.title)
        ? "device"
        : "chat");

  if (kind === "github") {
    return <GithubMark className="h-7 w-7" />;
  }
  if (kind === "device") {
    return <MonitorSmartphone className="h-7 w-7" strokeWidth={1.6} />;
  }
  return <MessageSquareText className="h-7 w-7" strokeWidth={1.6} />;
}

export function WorkList({
  items,
  onSelect,
  emptyLabel = "作業はまだありません",
}: WorkListProps) {
  if (items.length === 0) {
    return (
      <div className="mobile-work-list">
        <p className="px-2 text-[15px] text-[var(--mx-ink-muted)]">
          {emptyLabel}
        </p>
      </div>
    );
  }

  return (
    <div className="mobile-work-list" role="list">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="listitem"
          className="mobile-work-row"
          onClick={() => onSelect(item)}
          data-testid={`mobile-work-${item.id}`}
        >
          <span className="mobile-work-icon" aria-hidden>
            {iconFor(item)}
          </span>
          <span className="mobile-work-title">{item.title || "無題"}</span>
        </button>
      ))}
    </div>
  );
}
