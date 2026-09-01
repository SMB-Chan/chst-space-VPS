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
import { Surface } from "@/design-system/surface";
import { Chip } from "@/design-system/chip";

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
    <div className="m3-surface relative isolate min-h-[100dvh] overflow-hidden">
      <div className="ambient-grid pointer-events-none absolute inset-0 -z-20 opacity-35" />
      <div className="pointer-events-none absolute left-[-12rem] top-[-16rem] -z-10 h-[34rem] w-[34rem] rounded-full bg-primary/8 blur-3xl" />

      <Surface
        asChild
        tone="low"
        shape="none"
        className="sticky top-0 z-20 border-b border-[var(--m3-outline-variant)]"
      >
        <header>
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
            <div className="flex items-center gap-2.5 font-medium">
              <div className="flex h-10 w-10 items-center justify-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                <Command className="h-[18px] w-[18px]" />
              </div>
              <div className="leading-none">
                <div className="tracking-tight">AI Space</div>
                <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--m3-on-surface-variant)]">
                  Personal workspace
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Link href="/sign-in">
                <Button variant="ghost" className="h-9 px-3 sm:px-4">
                  サインイン
                </Button>
              </Link>
              <Link href="/sign-up">
                <Button variant="filled" className="h-9 px-4 sm:px-5">
                  無料ではじめる
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
        </header>
      </Surface>

      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-16 sm:px-8 md:pt-24 lg:grid-cols-[1.02fr_0.98fr] lg:gap-16 lg:pb-28 lg:pt-28">
          <div className="animate-rise-in text-center lg:text-left">
            <div className="mb-6 flex justify-center lg:justify-start">
              <Chip asChild selected>
                <span>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--m3-primary)] opacity-40" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--m3-primary)]" />
                  </span>
                  調査・推論・成果物生成をひとつに
                </span>
              </Chip>
            </div>
            <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.045em] sm:text-5xl md:text-6xl lg:text-[4.15rem]">
              考える仕事に、
              <span className="text-[var(--m3-primary)]">静かに集中できる</span>
              <br className="hidden sm:block" /> AIワークスペース。
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-base font-light leading-8 text-[var(--m3-on-surface-variant)] sm:text-lg lg:mx-0 lg:max-w-xl">
              複数モデル、Webリサーチ、ファイル解析、資料生成。
              高度なバックエンド機能を、迷わず使える一つのチャット画面にまとめました。
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
              <Link href="/sign-up">
                <Button size="lg" variant="filled" className="w-full sm:w-auto">
                  ワークスペースを開く
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/sign-in">
                <Button size="lg" variant="elevated" className="w-full sm:w-auto">
                  既存アカウントで続ける
                </Button>
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-[var(--m3-on-surface-variant)] lg:justify-start">
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
            <Surface
              tone="low"
              shape="extraLarge"
              className="relative overflow-hidden border border-[var(--m3-outline-variant)] p-2 shadow-[var(--m3-elevation-3)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--m3-outline-variant)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-xs font-medium">Research session</span>
                </div>
                <Chip asChild>
                  <span>GPT-5.6 Terra</span>
                </Chip>
              </div>
              <div className="space-y-5 px-4 py-6 sm:px-6">
                <div className="ml-auto max-w-[84%] rounded-[var(--m3-shape-lg)] rounded-tr-[var(--m3-shape-xs)] bg-[var(--m3-primary)] px-4 py-3 text-sm leading-6 text-[var(--m3-on-primary)] shadow-[var(--m3-elevation-1)]">
                  市場の最新動向を調査して、意思決定用の要点と出典をまとめて。
                </div>
                <Surface
                  tone="container"
                  shape="large"
                  className="max-w-[92%] border border-[var(--m3-outline-variant)] p-4"
                >
                  <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--m3-on-surface-variant)]">
                    <Sparkles className="h-3.5 w-3.5 text-[var(--m3-primary)]" />
                    AI Space
                  </div>
                  <div className="space-y-2.5">
                    <div className="h-2 w-[92%] rounded-full bg-foreground/12" />
                    <div className="h-2 w-[78%] rounded-full bg-foreground/10" />
                    <div className="h-2 w-[86%] rounded-full bg-foreground/10" />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {["市場分析", "競合比較", "出典整理"].map((label) => (
                      <Surface
                        key={label}
                        tone="low"
                        shape="small"
                        className="px-2 py-2.5 text-center text-[10px] text-[var(--m3-on-surface-variant)]"
                      >
                        {label}
                      </Surface>
                    ))}
                  </div>
                </Surface>
                <div className="m3-floating-surface rounded-[var(--m3-shape-xl)] p-3">
                  <div className="h-12 px-2 text-sm text-[var(--m3-on-surface-variant)]">
                    続けて質問する...
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" size="icon" className="h-9 w-9">
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <Chip asChild>
                        <span>ツール</span>
                      </Chip>
                    </div>
                    <Button size="icon" className="h-10 w-10">
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </Surface>
          </div>
        </section>

        <Surface asChild tone="low" shape="none">
          <section className="border-t border-[var(--m3-outline-variant)]">
            <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 lg:py-20">
              <div className="mb-10 max-w-2xl">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--m3-primary)]">
                  One focused interface
                </p>
                <h2 className="text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                  高度な機能ほど、操作はシンプルに。
                </h2>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {FEATURES.map(({ icon: Icon, title, desc }, index) => (
                  <Surface
                    key={title}
                    tone="container"
                    shape="extraLarge"
                    className="group p-5 transition-[transform,background-color] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-expressive)] hover:-translate-y-1 hover:bg-[var(--m3-surface-container-high)] sm:p-6"
                  >
                    <div className="mb-5 flex items-center justify-between">
                      <div className="flex h-11 w-11 items-center justify-center rounded-[var(--m3-shape-lg)] bg-[var(--m3-primary-container)] text-[var(--m3-on-primary-container)]">
                        <Icon className="h-5 w-5" />
                      </div>
                      <span className="font-mono text-[10px] text-[var(--m3-on-surface-variant)] opacity-60">
                        0{index + 1}
                      </span>
                    </div>
                    <h3 className="mb-2 font-semibold">{title}</h3>
                    <p className="text-sm font-light leading-6 text-[var(--m3-on-surface-variant)]">
                      {desc}
                    </p>
                  </Surface>
                ))}
              </div>
            </div>
          </section>
        </Surface>
      </main>
    </div>
  );
}
