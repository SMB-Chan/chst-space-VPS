import { cn } from "@/lib/utils";

export type MobileTab = "chat" | "work";

interface SegmentedControlProps {
  value: MobileTab;
  onChange: (value: MobileTab) => void;
  className?: string;
}

const TABS: { id: MobileTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "work", label: "Work" },
];

export function SegmentedControl({
  value,
  onChange,
  className,
}: SegmentedControlProps) {
  return (
    <div
      role="tablist"
      aria-label="メインタブ"
      className={cn("mobile-segment", className)}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          data-testid={`mobile-tab-${tab.id}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
