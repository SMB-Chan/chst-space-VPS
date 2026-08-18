import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { ChatLayout } from '@/components/layout/chat-layout';
import { ChatPage } from '@/pages/chat';
import { HomePage } from '@/pages/home';
import { SettingsPage } from '@/pages/settings';
import {
  Redirect,
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (Clerk hits dev FAPI directly), auto-set in prod.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

function MissingClerkKey() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-6 text-center">
      <div className="max-w-md space-y-3">
        <h1 className="text-xl font-serif text-foreground">セットアップが必要です</h1>
        <p className="text-sm text-muted-foreground">
          <code className="text-foreground">VITE_CLERK_PUBLISHABLE_KEY</code> が設定されていません。
          <code className="text-foreground">.env.example</code> をコピーしてキーを入れてください。
        </p>
      </div>
    </div>
  );
}

function AuthLoading() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background">
      <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
    </div>
  );
}

// Dark theme appearance matching the app (bg-background / bg-card / amber primary)
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(35 92% 55%)',
    colorForeground: 'hsl(220 15% 90%)',
    colorMutedForeground: 'hsl(220 10% 55%)',
    colorDanger: 'hsl(0 72% 55%)',
    colorBackground: 'hsl(224 25% 9%)',
    colorInput: 'hsl(224 25% 12%)',
    colorInputForeground: 'hsl(220 15% 90%)',
    colorNeutral: 'hsl(220 15% 85%)',
    fontFamily: "'Outfit', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox:
      'bg-card border border-border rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-foreground font-serif tracking-tight',
    headerSubtitle: 'text-muted-foreground',
    socialButtonsBlockButtonText: 'text-foreground',
    formFieldLabel: 'text-foreground/90',
    footerActionLink: 'text-primary hover:text-primary/80',
    footerActionText: 'text-muted-foreground',
    dividerText: 'text-muted-foreground',
    identityPreviewEditButton: 'text-primary',
    formFieldSuccessText: 'text-muted-foreground',
    alertText: 'text-foreground',
    logoBox: 'justify-center',
    logoImage: 'rounded-xl',
    socialButtonsBlockButton:
      'bg-secondary border border-border hover:bg-secondary/80',
    formButtonPrimary:
      'bg-primary text-primary-foreground hover:bg-primary/90 font-medium',
    formFieldInput: 'bg-input border-border text-foreground',
    footerAction: 'justify-center',
    dividerLine: 'bg-border',
    alert: 'bg-destructive/10 border border-destructive/30',
    otpCodeFieldInput: 'bg-input border-border text-foreground',
    formFieldRow: 'gap-2',
    main: 'gap-6',
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

// Invalidate the QueryClient cache when the signed-in user changes.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function HomeRedirect() {
  const { isLoaded } = useAuth();
  if (!isLoaded) return <AuthLoading />;
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/chat" />
      </Show>
      <Show when="signed-out">
        <HomePage />
      </Show>
    </>
  );
}

function ProtectedChat({ children }: { children: ReactNode }) {
  const { isLoaded } = useAuth();
  if (!isLoaded) return <AuthLoading />;
  return (
    <>
      <Show when="signed-in">
        <ChatLayout>
          <RoutedErrorBoundary>{children}</RoutedErrorBoundary>
        </ChatLayout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      {/* REQUIRED — the /*? optional wildcard matches the bare URL and Clerk's OAuth sub-paths */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/chat">
        <ProtectedChat>
          <ChatPage />
        </ProtectedChat>
      </Route>
      <Route path="/private">
        <ProtectedChat>
          <ChatPage />
        </ProtectedChat>
      </Route>
      <Route path="/settings">
        <ProtectedChat>
          <SettingsPage />
        </ProtectedChat>
      </Route>
      <Route path="/conversations/:id">
        <ProtectedChat>
          <ChatPage />
        </ProtectedChat>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'おかえりなさい',
            subtitle: 'AI Space にサインインして続ける',
          },
        },
        signUp: {
          start: {
            title: 'アカウントを作成',
            subtitle: 'AI Space をはじめましょう',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  // Force dark mode for this app
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  if (!clerkPubKey) {
    return <MissingClerkKey />;
  }

  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
