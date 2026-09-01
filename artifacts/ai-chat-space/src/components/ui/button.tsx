import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "m3-focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--m3-shape-full)] text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-emphasized)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-[var(--m3-state-disabled)]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--m3-primary)] text-[var(--m3-on-primary)] shadow-[var(--m3-elevation-1)] hover:brightness-[0.96] hover:shadow-[var(--m3-elevation-2)]",
        filled:
          "bg-[var(--m3-primary)] text-[var(--m3-on-primary)] shadow-[var(--m3-elevation-1)] hover:brightness-[0.96] hover:shadow-[var(--m3-elevation-2)]",
        tonal:
          "bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)] hover:brightness-[1.04]",
        elevated:
          "bg-[var(--m3-surface-container-low)] text-[var(--m3-primary)] shadow-[var(--m3-elevation-1)] hover:bg-[var(--m3-surface-container-high)] hover:shadow-[var(--m3-elevation-2)]",
        destructive:
          "bg-[var(--m3-error)] text-[var(--m3-on-error)] shadow-[var(--m3-elevation-1)] hover:brightness-[0.96]",
        outline:
          "border border-[var(--m3-outline)] bg-transparent text-[var(--m3-on-surface)] hover:bg-[var(--m3-surface-container)]",
        secondary:
          "bg-[var(--m3-secondary-container)] text-[var(--m3-on-secondary-container)] hover:brightness-[1.04]",
        ghost:
          "bg-transparent text-[var(--m3-on-surface-variant)] hover:bg-[var(--m3-surface-container)] hover:text-[var(--m3-on-surface)]",
        link:
          "rounded-[var(--m3-shape-xs)] bg-transparent px-1 text-[var(--m3-primary)] underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-10 px-5",
        sm: "h-8 px-3.5 text-[13px]",
        lg: "h-12 px-7 text-base",
        icon: "h-10 w-10 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
