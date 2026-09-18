import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** One sentence. Verb-first is fine — Apple HIG "Writing, 5.1". */
  title: string;
  /** Short explanation of why this surface is empty and what to do next. */
  description?: string;
  /** Single primary action. Button text should be a verb. */
  primaryAction?: ReactNode;
  /** Optional secondary action — e.g. "スキップ" or "詳細を見る". */
  secondaryAction?: ReactNode;
  /** Optional icon — lucide-react node, sized inline. */
  icon?: ReactNode;
  /** Reduce vertical padding. Default keeps the standard 80px top/bottom. */
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Apple HIG §5.2 ("空状態"):
 *   "What is not there, → what to do next. Place the primary action button."
 *
 * Single-purpose surface used wherever a list, table, or panel has zero rows.
 */
export function EmptyState({
  title,
  description,
  primaryAction,
  secondaryAction,
  icon,
  compact,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-col items-center justify-center text-center",
        compact ? "py-10" : "py-20",
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mb-5 flex h-14 w-14 items-center justify-center rounded-[var(--m3-shape-xl)] bg-[var(--m3-surface-container)] text-[var(--m3-on-surface-variant)]"
        >
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold tracking-tight text-[var(--m3-on-surface)]">
        {title}
      </h2>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
          {description}
        </p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
      {children}
    </div>
  );
}
