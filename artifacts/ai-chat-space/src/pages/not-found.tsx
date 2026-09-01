import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 mx-auto rounded-[22px] bg-destructive/10 border border-destructive/25 flex items-center justify-center mb-6">
          <AlertCircle className="h-7 w-7 text-destructive" />
        </div>
        <h1 className="text-3xl font-serif font-medium text-foreground tracking-tight mb-2">
          ページが見つかりません
        </h1>
        <p className="text-sm text-muted-foreground mb-8">
          指定された URL は存在しません。ホームに戻ってやり直してください。
        </p>
        <Link href="/">
          <Button size="lg">ホームへ戻る</Button>
        </Link>
      </div>
    </div>
  );
}
