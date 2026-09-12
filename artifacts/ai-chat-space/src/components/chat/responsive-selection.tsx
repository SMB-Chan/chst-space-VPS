import type { ReactNode } from "react";
import { useState } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DrawerClose,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { X } from "lucide-react";

interface ResponsiveSelectionProps {
  trigger: ReactNode;
  title: string;
  description?: string;
  disabled?: boolean;
  contentTestId?: string;
  desktopContent: ReactNode;
  mobileContent: (close: () => void) => ReactNode;
  desktopContentClassName?: string;
  mobileContentClassName?: string;
}

/**
 * Keeps selection menus anchored on desktop and moves them into a bounded,
 * modal bottom sheet on small screens. The option list is the only scrolling
 * region on mobile, so the sheet never grows underneath the composer.
 */
export function ResponsiveSelection({
  trigger,
  title,
  description,
  disabled,
  contentTestId,
  desktopContent,
  mobileContent,
  desktopContentClassName,
  mobileContentClassName,
}: ResponsiveSelectionProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <DrawerTrigger asChild disabled={disabled}>
          {trigger}
        </DrawerTrigger>
        <DrawerContent
          data-testid={contentTestId}
          className="responsive-selection-sheet mt-0 overflow-hidden border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)]"
        >
          <DrawerHeader className="relative shrink-0 px-5 pb-3 pt-2 pr-16 text-left">
            <DrawerTitle className="text-lg font-semibold">{title}</DrawerTitle>
            <DrawerClose
              className="m3-focus-ring absolute right-3 top-0 flex h-11 w-11 items-center justify-center rounded-[var(--m3-shape-full)] hover:bg-foreground/10"
              aria-label="選択画面を閉じる"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </DrawerClose>
            {description ? (
              <DrawerDescription className="mt-1 text-left text-xs leading-relaxed text-[var(--m3-on-surface-variant)]">
                {description}
              </DrawerDescription>
            ) : null}
          </DrawerHeader>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2",
              mobileContentClassName,
            )}
          >
            {mobileContent(close)}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-testid={contentTestId}
        className={desktopContentClassName}
      >
        {desktopContent}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
