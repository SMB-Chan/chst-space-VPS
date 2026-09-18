import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ScreenHeaderProps {
  /** Title rendered as <h1>. Apple HIG prefers sentence-case titles. */
  title: string;
  /** Short plain-language description of the surface's purpose. */
  description?: string;
  /** Right-aligned controls (e.g. "新規", "同期", "保存"). Verb-first. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Apple HIG §3.6 Simplicity: "One screen, one purpose".
 *
 * Standard above-the-fold header. Renders an accessible landmark via the
 * `<header>` and a level-1 heading.
 */
export function ScreenHeader({
  title,
  description,
  actions,
  className,
}: ScreenHeaderProps) {
  return (
    <header className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--m3-on-surface)]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-[var(--m3-on-surface-variant)]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
