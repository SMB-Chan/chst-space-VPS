import { Link } from "wouter";
import {
  ArrowRight,
  Command,
  FileOutput,
  Globe2,
  Paperclip,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    icon: Sparkles,
    title: "最適なモデルを選択",
    desc: "OpenAIとQwenを、速度・推論・画像理解に合わせて切り替え。",
  },
  {
    icon: Search,
    title: "調査から回答まで",
    desc: "Web検索、情報収集、出典整理をひとつの会話の中で完結。",
  },
  {
    icon: FileOutput,
    title: "成果物まで生成",
    desc: "PDF、Word、Excel、PowerPointを会話から直接作成。",
  },
] as const;

export function HomePage() {
  return (
    <div className="relative isolate min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="ambient-grid pointer-events-none absolute inset-0 -z-20" />
      <div className="pointer-events-none absolute left-[-12rem] top-[-16rem] -z-10 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-18rem] right-[-10rem] -z-10 h-[36rem] w-[36rem] rounded-full bg-sky-500/8 blur-3xl" />

      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-2.5 font-medium">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 shadow-sm">
              <Command className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="leading-none">
              <div className="tracking-tight">AI Space</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Personal workspace
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Link href="/sign-in">
              <Button
                variant="ghost"
                className="h-9 px-3 text-foreground/75 hover:text-foreground sm:px-4"
              >
                サインイン
              </Button>
            </Link>
            <Link href="/sign-up">
              <Button className="h-9 rounded-full bg-primary px-4 text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90 sm:px-5">
                無料ではじめる
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-16 sm:px-8 md:pt-24 lg:grid-cols-[1.02fr_0.98fr] lg:gap-16 lg:pb-28 lg:pt-28">
          <div className="animate-rise-in text-center lg:text-left">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 px-3 py-1.5 text-xs font-medium text-primary">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              調査・推論・成果物生成をひとつに
            </div>
            <h1 className="text-balance font-serif text-4xl font-medium leading-[1.08] tracking-[-0.035em] sm:text-5xl md:text-6xl lg:text-[4.15rem]">
              考える仕事に、
              <span className="text-primary">静かに集中できる</span>
              <br className="hidden sm:block" /> AIワークスペース。
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-base font-light leading-8 text-muted-foreground sm:text-lg lg:mx-0 lg:max-w-xl">
              複数モデル、Webリサーチ、ファイル解析、資料生成。
              高度なバックエンド機能を、迷わず使える一つのチャット画面にまとめました。
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
              <Link href="/sign-up">
                <Button
                  size="lg"
                  className="h-12 w-full rounded-full bg-primary px-7 text-primary-foreground shadow-xl shadow-primary/20 hover:-translate-y-0.5 hover:bg-primary/90 sm:w-auto"
                >
                  ワークスペースを開く
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/sign-in">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-12 w-full rounded-full border-border/80 bg-card/50 px-7 backdrop-blur hover:bg-card sm:w-auto"
                >
                  既存アカウントで続ける
                </Button>
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground lg:justify-start">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                会話データを安全に保存
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Globe2 className="h-3.5 w-3.5 text-sky-500" />
                出典つきWebリサーチ
              </span>
            </div>
          </div>

          <div className="animate-rise-in relative mx-auto w-full max-w-2xl [animation-delay:120ms]">
            <div className="surface-panel relative overflow-hidden rounded-[2rem] p-2 shadow-2xl">
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-xs font-medium">Research session</span>
                </div>
                <span className="rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[10px] text-muted-foreground">
                  GPT-5.6 Terra
                </span>
              </div>
              <div className="space-y-5 px-4 py-6 sm:px-6">
                <div className="ml-auto max-w-[84%] rounded-[1.35rem] rounded-tr-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-lg shadow-primary/10">
                  市場の最新動向を調査して、意思決定用の要点と出典をまとめて。
                </div>
                <div className="max-w-[92%] rounded-[1.35rem] rounded-tl-md border border-border/70 bg-card/70 p-4 shadow-sm">
                  <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Space
                  </div>
                  <div className="space-y-2.5">
                    <div className="h-2 w-[92%] rounded-full bg-foreground/12" />
                    <div className="h-2 w-[78%] rounded-full bg-foreground/10" />
                    <div className="h-2 w-[86%] rounded-full bg-foreground/10" />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {["市場分析", "競合比較", "出典整理"].map((label) => (
                      <div
                        key={label}
                        className="rounded-xl border border-border/60 bg-background/60 px-2 py-2.5 text-center text-[10px] text-muted-foreground"
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-[1.35rem] border border-border/70 bg-background/65 p-3 shadow-lg backdrop-blur">
                  <div className="h-12 px-2 text-sm text-muted-foreground/70">
                    続けて質問する...
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground">
                        <Paperclip className="h-4 w-4" />
                      </div>
                      <span className="rounded-full border border-border/70 px-2.5 py-1 text-[10px] text-muted-foreground">
                        ツール
                      </span>
                    </div>
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
                      <ArrowRight className="h-4 w-4" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="absolute -bottom-5 -left-5 -z-10 h-32 w-32 rounded-full bg-primary/15 blur-2xl" />
            <div className="absolute -right-5 -top-5 -z-10 h-36 w-36 rounded-full bg-sky-500/10 blur-2xl" />
          </div>
        </section>

        <section className="border-t border-border/60 bg-card/25">
          <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 lg:py-20">
            <div className="mb-10 max-w-2xl">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                One focused interface
              </p>
              <h2 className="text-balance font-serif text-3xl font-medium tracking-tight sm:text-4xl">
                高度な機能ほど、操作はシンプルに。
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, desc }, index) => (
                <div
                  key={title}
                  className="surface-panel group rounded-2xl p-5 transition duration-300 hover:-translate-y-1 hover:border-primary/25 sm:p-6"
                >
                  <div className="mb-5 flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/8 text-primary transition group-hover:bg-primary/12">
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground/50">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mb-2 font-medium">{title}</h3>
                  <p className="text-sm font-light leading-6 text-muted-foreground">
                    {desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
