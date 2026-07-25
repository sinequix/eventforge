import { useCallback, useState } from "react";
import App from "./App";
import SignInPage, { type Session } from "./SignInPage";

// Renders the console only once a session exists. This is presentation only —
// the API re-authenticates every request and resolves the role from
// workspace_memberships, so hiding the UI is not the security boundary.
export default function ConsoleGate() {
  const [session, setSession] = useState<Session | undefined>();
  const onSignedIn = useCallback((next: Session) => setSession(next), []);
  return session ? <App /> : <SignInPage onSignedIn={onSignedIn} />;
}
