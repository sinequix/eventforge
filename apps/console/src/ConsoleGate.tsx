import { useCallback, useEffect, useState } from "react";
import App from "./App";
import AdminDashboard from "./dashboard/AdminDashboard";
import SignInPage, { fetchSession, type Session } from "./SignInPage";

/**
 * True when the console is served from a developer machine rather than a hosted
 * origin.
 *
 * Hosted sign-in is a hosted concern: `/api/auth/*` is served by the deployed
 * Worker, and the Vite dev server has no such route. Gating localhost would ask
 * for a session that cannot be obtained, which broke `pnpm dev` for the console.
 *
 * Skipping the gate here does not widen access. The local control plane binds to
 * loopback only and is unauthenticated by design (see resolveRuntimeConfig:
 * `local` mode refuses any non-loopback host), so there is no credential for this
 * page to withhold. Remote mode is what requires an authenticated request
 * provider, and that path is unaffected.
 */
export function isLocalDevOrigin(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export default function ConsoleGate() {
  const [session, setSession] = useState<Session | undefined>();
  const onSignedIn = useCallback((next: Session) => setSession(next), []);
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetchSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (restoring)
    return (
      <main className="ef-signin">
        <p role="status">Checking your session…</p>
      </main>
    );

  // The desktop shell supplies its own control-plane URL and never has a hosted
  // session either.
  if (window.eventforgeDesktop) return <App />;

  const hasSignInToken = new URLSearchParams(window.location.search).has("token");

  // A hosted session (including one obtained on loopback behind the local
  // Cloudflare tunnel) is the admin dashboard. Loopback without a session still
  // skips the login form so `pnpm dev` can reach the unauthenticated operations
  // UI, unless a one-time sign-in token is present.
  if (session)
    return <AdminDashboard session={session} onSignedOut={() => setSession(undefined)} />;
  if (isLocalDevOrigin(window.location.hostname) && !hasSignInToken) return <App />;

  // Presentation only — the API re-authenticates every request and resolves the
  // role from workspace_memberships, so hiding the UI is not the boundary.
  return <SignInPage onSignedIn={onSignedIn} />;
}
