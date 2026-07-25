import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";

// Console sign-in.
//
// Primary path is email + password, gated by a Cloudflare Turnstile challenge that
// the server verifies against siteverify before doing any credential work.
//
// The one-time email link is kept as the recovery path: a password you cannot
// remember has to be reset through something, and email possession is that
// something.
//
// The request token returned on success is held in memory only. localStorage
// would expose it to any XSS, and it is the second factor that stops a stolen
// cookie from acting alone.

const REQUEST_TOKEN_HEADER = "x-eventforge-request-token";
const TURNSTILE_SITE_KEY = "0x4AAAAAAD9xmwCBw00F8QF2";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

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

function useTurnstile(onToken: (token: string) => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function render() {
      if (cancelled || !containerRef.current || !window.turnstile || widgetRef.current) return;
      widgetRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
        callback: onToken,
        // An expired or errored challenge clears the token so the form cannot be
        // submitted with a stale one.
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
      setReady(true);
    }

    if (window.turnstile) {
      render();
      return () => {
        cancelled = true;
      };
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${TURNSTILE_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = `${TURNSTILE_SRC}?render=explicit`;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener("load", render);
    return () => {
      cancelled = true;
      script.removeEventListener("load", render);
    };
  }, [onToken]);

  const reset = useCallback(() => {
    window.turnstile?.reset(widgetRef.current);
    onToken("");
  }, [onToken]);

  return { containerRef, ready, reset };
}

type Mode = "password" | "link";

export default function SignInPage({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [linkSent, setLinkSent] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const onToken = useCallback((token: string) => setCaptchaToken(token), []);
  const { containerRef, ready, reset } = useTurnstile(onToken);

  // A token in the URL means the operator followed a one-time link.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    void (async () => {
      setVerifying(true);
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { detail?: string };
        setVerifying(false);
        setError(problem.detail ?? "The sign-in link could not be verified.");
        return;
      }
      const body = (await response.json()) as { requestToken: string };
      requestToken = body.requestToken;
      // Strip the token so it is not left in browser history.
      window.history.replaceState({}, "", "/console");
      const session = await fetchSession();
      setVerifying(false);
      if (session) onSignedIn(session);
      else setError("Signed in, but the session could not be read.");
    })();
  }, [onSignedIn]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, turnstileToken: captchaToken }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(problem.detail ?? "Sign-in failed.");
        // A consumed challenge cannot be replayed, so always issue a fresh one.
        reset();
        return;
      }
      const body = (await response.json()) as { requestToken: string };
      requestToken = body.requestToken;
      const session = await fetchSession();
      if (session) onSignedIn(session);
      else setError("Signed in, but the session could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function submitLink(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // 202 regardless of whether the address exists — no account enumeration.
      if (response.ok) setLinkSent(true);
      else setError("Sign-in is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  if (verifying)
    return (
      <main className="ef-signin">
        <div className="ef-signin-card">
          <a className="ef-brand" href="/">
            <Mark />
            <span>EventForge</span>
          </a>
          <p className="ef-signin-status">Verifying your sign-in link…</p>
        </div>
      </main>
    );

  return (
    <main className="ef-signin">
      <div className="ef-signin-card">
        <a className="ef-brand" href="/">
          <Mark />
          <span>EventForge</span>
        </a>

        {linkSent ? (
          <>
            <h1>Check your email</h1>
            <p className="ef-signin-copy">
              If <strong>{email}</strong> has access, a one-time sign-in link is on its way. It
              expires in 15 minutes and works once.
            </p>
            <button
              className="ef-signin-secondary"
              onClick={() => {
                setLinkSent(false);
                setMode("password");
              }}
              type="button"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <p className="ef-signin-copy">
              {mode === "password"
                ? "Use your email and password."
                : "We will email you a one-time sign-in link."}
            </p>

            {error && (
              <p className="ef-signin-error" role="alert">
                {error}
              </p>
            )}

            <form onSubmit={mode === "password" ? submitPassword : submitLink}>
              <label htmlFor="ef-signin-email">Email</label>
              <input
                autoComplete="username"
                id="ef-signin-email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />

              {mode === "password" && (
                <>
                  <label htmlFor="ef-signin-password">Password</label>
                  <input
                    autoComplete="current-password"
                    id="ef-signin-password"
                    minLength={12}
                    name="password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                  <div className="ef-signin-captcha" ref={containerRef} />
                </>
              )}

              <button
                className="ef-signin-primary"
                disabled={busy || (mode === "password" && (!captchaToken || !ready))}
                type="submit"
              >
                {busy
                  ? "Working…"
                  : mode === "password"
                    ? captchaToken
                      ? "Sign in"
                      : "Complete the challenge"
                    : "Email me a link"}
              </button>
            </form>

            <button
              className="ef-signin-link"
              onClick={() => {
                setMode(mode === "password" ? "link" : "password");
                setError(undefined);
              }}
              type="button"
            >
              {mode === "password" ? "Forgot your password? Sign in by email" : "Use a password"}
            </button>
          </>
        )}

        <p className="ef-signin-foot">
          Pre-production environment. <a href="/">Return to eventforge.dev</a>
        </p>
      </div>
    </main>
  );
}
