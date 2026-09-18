import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  /** One sentence describing the problem in concrete terms. */
  title: string;
  /** A direct sentence describing what the user can do to resolve it. */
  description?: string;
  /** Verb-first retry / recovery action. */
  primaryAction?: ReactNode;
  /** Verb-first alternative action (e.g. "トップへ戻る"). */
  secondaryAction?: ReactNode;
  /** Customize the icon — defaults to AlertTriangle. */
  icon?: ReactNode;
  /** Title level override. Default is `h1` for top-level surfaces. */
  as?: "h1" | "h2";
  className?: string;
}

/**
 * Apple HIG §5.2 ("エラー"):
 *   "The message appears near the problem. The text does not blame. It
 *    states the fix."
 *
 * `role="alert"` (announced by VoiceOver). Use for surfaced failures, not
 * for inline form-field errors (those have their own pattern).
 */
export function ErrorState({
  title,
  description,
  primaryAction,
  secondaryAction,
  icon,
  as = "h1",
  className,
}: ErrorStateProps) {
  const Heading = as;
  return (
    <div
      role="alert"
      className={cn(
        "flex w-full flex-col items-center justify-center text-center",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-[var(--m3-shape-xl)] bg-[var(--m3-error-container)] text-[var(--m3-on-error-container)]"
      >
        {icon ?? <AlertTriangle className="h-6 w-6" />}
      </div>
      <Heading className="text-lg font-semibold tracking-tight text-[var(--m3-on-surface)]">
        {title}
      </Heading>
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
    </div>
  );
}
