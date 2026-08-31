import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center">
        <div className="flex items-center justify-center gap-2 mb-4 text-destructive">
          <AlertCircle className="h-7 w-7" />
          <h1 className="text-2xl font-serif font-medium text-foreground">
            ページが見つかりません
          </h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          指定された URL は存在しません。ホームに戻ってやり直してください。
        </p>
        <Link href="/">
          <Button>ホームへ戻る</Button>
        </Link>
      </div>
    </div>
  );
}
