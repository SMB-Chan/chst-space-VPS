import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "m3-focus-ring flex min-h-[72px] w-full rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)] px-3.5 py-3 text-base text-[var(--m3-on-surface)] shadow-none transition-[background-color,border-color,box-shadow] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)] placeholder:text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container)] focus-visible:border-[var(--m3-primary)] disabled:cursor-not-allowed disabled:opacity-[var(--m3-state-disabled)] md:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
