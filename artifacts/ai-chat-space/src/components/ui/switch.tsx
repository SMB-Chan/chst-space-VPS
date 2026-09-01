import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "m3-focus-ring peer inline-flex h-8 w-[52px] shrink-0 cursor-pointer items-center rounded-[var(--m3-shape-full)] border p-[3px] transition-[background-color,border-color] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-emphasized)] disabled:cursor-not-allowed disabled:opacity-[var(--m3-state-disabled)] data-[state=checked]:border-[var(--m3-primary)] data-[state=checked]:bg-[var(--m3-primary)] data-[state=unchecked]:border-[var(--m3-outline)] data-[state=unchecked]:bg-[var(--m3-surface-container-high)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className="pointer-events-none block h-6 w-6 rounded-[var(--m3-shape-full)] bg-[var(--m3-on-surface-variant)] shadow-[var(--m3-elevation-1)] transition-[transform,width,background-color] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-expressive)] data-[state=checked]:translate-x-5 data-[state=checked]:bg-[var(--m3-on-primary)] data-[state=unchecked]:translate-x-0"
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
