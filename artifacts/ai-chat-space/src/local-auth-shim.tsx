import type { ReactNode } from "react";

// Build-time replacement for @clerk/react / @clerk/themes on local-mode
// deployments (VPS + Tailnet, AUTH_MODE=local). vite.config.ts aliases the
// Clerk modules here so the same components build without Clerk keys.
// The client-side identity is fixed; the API enforces auth per request via
// requireAuth's local mode.

export const LOCAL_USER_ID = "local-user";

export function publishableKeyFromHost(): string {
  return "";
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  return { isLoaded: true, isSignedIn: true, userId: LOCAL_USER_ID };
}

export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: LOCAL_USER_ID,
      firstName: "Local",
      fullName: "Local User",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "local@tailnet" },
    },
  };
}

export function useClerk() {
  return {
    signOut: () => {
      window.location.reload();
    },
    addListener: () => () => {},
    openSignIn: () => {},
  };
}

export function Show({
  when,
  children,
}: {
  when: "signed-in" | "signed-out";
  children: ReactNode;
}) {
  return when === "signed-in" ? <>{children}</> : null;
}

export function SignIn() {
  return <div />;
}

export function SignUp() {
  return <div />;
}

export const shadcn = {};
