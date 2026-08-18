import { Link } from 'wouter';
import { Command, Sparkles, Globe, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function HomePage() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
      <header className="flex items-center justify-between px-6 h-16 border-b border-border">
        <div className="flex items-center gap-2 font-medium">
          <Command className="w-5 h-5 text-primary" />
          <span className="tracking-tight">AI Space</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/sign-in">
            <Button variant="ghost" className="text-foreground/80 hover:text-foreground">
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
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-8 shadow-inner border border-primary/20">
          <Sparkles className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-4xl md:text-5xl font-serif font-medium tracking-tight mb-4 max-w-2xl">
          あなた専用のAIチャットスペース
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl font-light mb-10">
          複数のAIモデルとの会話、Web検索、ドキュメント添付。
          アカウントを作成すると、会話はあなただけのものとして安全に保存されます。
        </p>
        <div className="flex items-center gap-3">
          <Link href="/sign-up">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8">
              アカウント作成
            </Button>
          </Link>
          <Link href="/sign-in">
            <Button size="lg" variant="outline" className="px-8">
              サインイン
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-16 max-w-3xl w-full">
          {[
            { icon: Sparkles, title: '複数モデル対応', desc: 'OpenAIとQwenのモデルを切り替えて利用' },
            { icon: Globe, title: 'Web検索', desc: '最新情報を検索して回答に反映' },
            { icon: FileText, title: 'ファイル添付', desc: 'ドキュメントや画像を添付して質問' },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5 text-left">
              <Icon className="w-5 h-5 text-primary mb-3" />
              <div className="font-medium mb-1">{title}</div>
              <div className="text-sm text-muted-foreground">{desc}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
