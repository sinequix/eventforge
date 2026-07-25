import { expect, it } from "vitest";
import { isLocalDevOrigin } from "./ConsoleGate";

// Regression: adding hosted sign-in gated the local dev console behind a session
// it could never obtain, because /api/auth/* is served by the deployed Worker and
// not by the Vite dev server. `pnpm dev` showed a login form with no way through.
it("treats only loopback origins as local development", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(isLocalDevOrigin(host), `${host} must bypass hosted sign-in`).toBe(true);
});

it("never bypasses sign-in for a hosted origin", () => {
  for (const host of [
    "beta.eventforge.dev",
    "eventforge.dev",
    "localhost.evil.com",
    "127.0.0.1.evil.com",
    "notlocalhost",
    "",
  ])
    expect(isLocalDevOrigin(host), `${host} must still require sign-in`).toBe(false);
});
