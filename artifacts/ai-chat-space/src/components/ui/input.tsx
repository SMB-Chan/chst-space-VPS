import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "m3-focus-ring flex h-10 w-full rounded-[var(--m3-shape-md)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)] px-3.5 py-2 text-base text-[var(--m3-on-surface)] shadow-none transition-[background-color,border-color,box-shadow] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container)] focus-visible:border-[var(--m3-primary)] disabled:cursor-not-allowed disabled:opacity-[var(--m3-state-disabled)] md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
