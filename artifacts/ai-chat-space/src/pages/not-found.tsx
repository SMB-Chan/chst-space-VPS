import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/design-system/components";

/**
 * Apple HIG §3.6 (Simplicity) — the page speaks one purpose: where to go
 * next. The detail explains what's wrong; the button says where to go.
 */
export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <ErrorState
          icon={<AlertCircle className="h-6 w-6" />}
          title="ページが見つかりません"
          description="URL が正しくないか、すでに移動した可能性があります。"
          primaryAction={
            <Link href="/">
              <Button size="lg">ホームへ戻る</Button>
            </Link>
          }
        />
      </div>
    </div>
  );
}
