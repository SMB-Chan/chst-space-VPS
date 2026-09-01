import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const surfaceVariants = cva("text-foreground", {
  variants: {
    tone: {
      plain: "m3-surface",
      low: "m3-surface-container-low",
      container: "m3-surface-container",
      high: "m3-surface-container-high",
      outlined: "m3-outlined-surface",
      floating: "m3-floating-surface",
    },
    shape: {
      none: "rounded-none",
      small: "rounded-[var(--m3-shape-sm)]",
      medium: "rounded-[var(--m3-shape-md)]",
      large: "rounded-[var(--m3-shape-lg)]",
      extraLarge: "rounded-[var(--m3-shape-xl)]",
      full: "rounded-[var(--m3-shape-full)]",
    },
  },
  defaultVariants: {
    tone: "container",
    shape: "large",
  },
});

export interface SurfaceProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceVariants> {
  asChild?: boolean;
}

const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  ({ asChild = false, className, tone, shape, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        className={cn(surfaceVariants({ tone, shape }), className)}
        {...props}
      />
    );
  },
);

Surface.displayName = "Surface";

export { Surface, surfaceVariants };
