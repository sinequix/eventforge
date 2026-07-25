import { type FormEvent, useEffect, useState } from "react";
import { Mark } from "./Mark";

// Passwordless sign-in. The server issues a one-time link; there is no password
// field because there are no passwords in the identity model.
//
// The request token returned by /api/auth/verify is held in memory only. Putting
// it in localStorage would make it readable by any XSS, and it is the second
// factor that stops a stolen cookie from acting on its own.

const REQUEST_TOKEN_HEADER = "x-eventforge-request-token";

export type Session = {
  identity: { id: string; email: string };
  memberships: Array<{ workspaceId: string; role: string; version: number }>;
  capabilities: Record<string, boolean>;
};

let requestToken: string | undefined;

export function getRequestToken(): string | undefined {
  return requestToken;
}

export async function fetchSession(): Promise<Session | undefined> {
  if (!requestToken) return undefined;
  const response = await fetch("/api/auth/session", {
    headers: { [REQUEST_TOKEN_HEADER]: requestToken },
  });
  return response.ok ? ((await response.json()) as Session) : undefined;
}

type Phase =
  { kind: "email" } | { kind: "sent" } | { kind: "verifying" } | { kind: "error"; detail: string };

export default function SignInPage({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "email" });

  // A token in the URL means the operator followed a sign-in link.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    void (async () => {
      setPhase({ kind: "verifying" });
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { detail?: string };
        setPhase({
          kind: "error",
          detail: problem.detail ?? "The sign-in link could not be verified.",
        });
        return;
      }
      const body = (await response.json()) as { requestToken: string };
      requestToken = body.requestToken;
      // Strip the token from the address bar so it is not left in history.
      window.history.replaceState({}, "", "/console");
      const session = await fetchSession();
      if (session) onSignedIn(session);
      else setPhase({ kind: "error", detail: "Signed in, but the session could not be read." });
    })();
  }, [onSignedIn]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    // 202 regardless of whether the address exists, so this cannot enumerate accounts.
    setPhase(
      response.ok
        ? { kind: "sent" }
        : { kind: "error", detail: "Sign-in is unavailable right now." },
    );
  }

  return (
    <main className="ef-signin">
      <div className="ef-signin-card">
        <a className="ef-brand" href="/">
          <Mark />
          <span>EventForge</span>
        </a>

        {phase.kind === "verifying" && <p className="ef-signin-status">Verifying your link…</p>}

        {phase.kind === "sent" && (
          <>
            <h1>Check your email</h1>
            <p className="ef-signin-copy">
              If <strong>{email}</strong> has access, a one-time sign-in link is on its way. It
              expires in 15 minutes and works once.
            </p>
            <button className="ef-signin-secondary" onClick={() => setPhase({ kind: "email" })}>
              Use a different address
            </button>
          </>
        )}

        {(phase.kind === "email" || phase.kind === "error") && (
          <>
            <h1>Sign in</h1>
            <p className="ef-signin-copy">
              EventForge uses one-time email links. There is no password to lose.
            </p>
            {phase.kind === "error" && (
              <p className="ef-signin-error" role="alert">
                {phase.detail}
              </p>
            )}
            <form onSubmit={submit}>
              <label htmlFor="ef-signin-email">Work email</label>
              <input
                autoComplete="email"
                id="ef-signin-email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
              <button className="ef-signin-primary" type="submit">
                Send sign-in link
              </button>
            </form>
          </>
        )}

        <p className="ef-signin-foot">
          Pre-production environment. <a href="/">Return to eventforge.dev</a>
        </p>
      </div>
    </main>
  );
}
