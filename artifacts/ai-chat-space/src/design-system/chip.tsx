import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  selected?: boolean;
}

const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  ({ asChild = false, selected = false, className, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        data-selected={selected ? "true" : "false"}
        className={cn(
          "m3-chip m3-focus-ring inline-flex items-center justify-center gap-1.5 px-3 text-xs font-medium disabled:pointer-events-none disabled:opacity-[var(--m3-state-disabled)]",
          className,
        )}
        {...props}
      />
    );
  },
);

Chip.displayName = "Chip";

export { Chip };
