import { Link } from "wouter";
import { Command, Sparkles, Globe, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HomePage() {
  return (
    <div className="min-h-[100dvh] text-foreground flex flex-col">
      <header className="flex items-center justify-between px-6 h-16 border-b border-border/50 bg-background/60 backdrop-blur-2xl">
        <div className="flex items-center gap-2.5 font-medium">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/35 to-primary/5 border border-primary/25 flex items-center justify-center shadow-inner">
            <Command className="w-4 h-4 text-primary" />
          </div>
          <span className="tracking-tight">AI Space</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/sign-in">
            <Button
              variant="ghost"
              className="text-foreground/80 hover:text-foreground"
            >
              サインイン
            </Button>
          </Link>
          <Link href="/sign-up">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              無料ではじめる
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <div className="w-20 h-20 rounded-[28px] bg-gradient-to-br from-primary/30 to-primary/5 border border-primary/25 flex items-center justify-center mb-8 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08),0_16px_40px_-12px_rgb(0_0_0/0.5)]">
          <Sparkles className="w-9 h-9 text-primary" />
        </div>
        <h1 className="text-4xl md:text-6xl font-serif font-medium tracking-tight mb-5 max-w-2xl leading-[1.15]">
          あなた専用のAIチャットスペース
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl font-light mb-10">
          複数のAIモデルとの会話、Web検索、ドキュメント添付。
          アカウントを作成すると、会話はあなただけのものとして安全に保存されます。
        </p>
        <div className="flex items-center gap-3">
          <Link href="/sign-up">
            <Button size="lg" className="px-9">
              アカウント作成
            </Button>
          </Link>
          <Link href="/sign-in">
            <Button size="lg" variant="outline" className="px-9">
              サインイン
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-20 max-w-3xl w-full">
          {[
            {
              icon: Sparkles,
              title: "複数モデル対応",
              desc: "OpenAIとQwenのモデルを切り替えて利用",
            },
            {
              icon: Globe,
              title: "Web検索",
              desc: "最新情報を検索して回答に反映",
            },
            {
              icon: FileText,
              title: "ファイル添付",
              desc: "ドキュメントや画像を添付して質問",
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="glass-panel glass-hover rounded-3xl p-5 text-left"
            >
              <div className="w-10 h-10 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <div className="font-medium mb-1">{title}</div>
              <div className="text-sm text-muted-foreground">{desc}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
