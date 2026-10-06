import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  consoleOriginFor,
  hashToken,
  parseCookie,
  parseSessionCookieValue,
  rankOf,
  requestSignIn,
  roleAllows,
  safeEqual,
  sessionCookie,
  sessionCookieValue,
} from "../src/auth.js";

describe("role ordering", () => {
  // The enterprise-governance review left roles declared but unconsumed, so an
  // auditor would have received owner scope. These assertions are the gate that
  // was missing: every comparison goes through the rank order.
  it("ranks roles and denies anything outside the known set", () => {
    expect(rankOf("viewer")).toBe(0);
    expect(rankOf("owner")).toBe(3);
    for (const unknown of ["auditor", "OWNER", "", "root", "admin ", "__proto__", "toString"])
      expect(rankOf(unknown), `${unknown} must not rank`).toBe(-1);
  });

  it("never lets a lower role satisfy a higher requirement", () => {
    expect(roleAllows("owner", "admin")).toBe(true);
    expect(roleAllows("admin", "admin")).toBe(true);
    expect(roleAllows("operator", "admin")).toBe(false);
    expect(roleAllows("viewer", "operator")).toBe(false);
    // The specific escalation the review called out.
    expect(roleAllows("auditor", "viewer")).toBe(false);
    expect(roleAllows("auditor", "owner")).toBe(false);
  });

  it("denies a prototype-inherited property masquerading as a role", () => {
    // A plain `ROLE_RANK[role]` lookup would resolve "constructor" to a function
    // and rank it as truthy. Object.hasOwn is what makes this deny.
    expect(roleAllows("constructor", "viewer")).toBe(false);
    expect(roleAllows("hasOwnProperty", "viewer")).toBe(false);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, Secure and SameSite=Strict", () => {
    const cookie = sessionCookie("id.session", 3600);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("round-trips an identity and session pair", () => {
    const identityId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const parsed = parseSessionCookieValue(sessionCookieValue(identityId, sessionId));
    expect(parsed).toEqual({ identityId, sessionId });
  });

  it("rejects malformed cookie values instead of guessing", () => {
    for (const bad of [
      undefined,
      "",
      ".",
      "nope",
      ".onlysession",
      "onlyidentity.",
      "../../etc/passwd.22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111.not-a-uuid",
    ])
      expect(parseSessionCookieValue(bad), `${String(bad)} must not parse`).toBeUndefined();
  });

  it("reads its own cookie out of a crowded header", () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc.def; other=1`;
    expect(parseCookie(header, SESSION_COOKIE)).toBe("abc.def");
    expect(parseCookie(header, "missing")).toBeUndefined();
    expect(parseCookie(null, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("challenge tokens", () => {
  it("hashes the token so the stored value cannot be replayed", async () => {
    const token = "a".repeat(64);
    const digest = await hashToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(token);
    // Deterministic, so a lookup by hash works.
    expect(await hashToken(token)).toBe(digest);
    expect(await hashToken("b".repeat(64))).not.toBe(digest);
  });

  it("compares in constant time without short-circuiting on content", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("sign-in request does not sign unknown addresses up", () => {
  function identitiesDb(existing?: { id: string; email: string }) {
    const inserts: unknown[][] = [];
    return {
      inserts,
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            return {
              async first() {
                if (!sql.includes("from identities")) return null;
                if (!existing || bindings[0] !== existing.email) return null;
                return {
                  id: existing.id,
                  normalized_email: existing.email,
                  verified_at: null,
                };
              },
              async run() {
                inserts.push(bindings);
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
  }

  it("does not create an identity or send mail for an unknown address", async () => {
    const db = identitiesDb();
    const sent: unknown[] = [];
    const outcome = await requestSignIn(
      {
        CONTROL_DB: db,
        IDENTITY_AUTHORITY: { getByName: () => ({}) },
        ENVIRONMENT: "production",
        EMAIL: { send: async (message: unknown) => sent.push(message) },
        AUTH_CONSOLE_ORIGIN: "https://eventforge.dev",
      } as never,
      "new@example.com",
    );
    expect(outcome).toEqual({ accepted: true });
    expect(sent).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("sends a sign-in link only when the identity already exists", async () => {
    const db = identitiesDb({
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
    });
    const sent: Array<{ to: string; html: string }> = [];
    const outcome = await requestSignIn(
      {
        CONTROL_DB: db,
        IDENTITY_AUTHORITY: { getByName: () => ({}) },
        ENVIRONMENT: "production",
        EMAIL: { send: async (message: { to: string; html: string }) => sent.push(message) },
        AUTH_CONSOLE_ORIGIN: "https://eventforge.dev",
      } as never,
      "Owner@Example.com",
    );
    expect(outcome).toEqual({ accepted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@example.com");
    expect(sent[0]?.html).toContain("https://eventforge.dev/console?token=");
    expect(db.inserts).toHaveLength(1);
  });

  it("refuses a beta console origin even if configured", () => {
    expect(
      consoleOriginFor({
        AUTH_CONSOLE_ORIGIN: "https://beta.eventforge.dev",
        ENVIRONMENT: "preview",
      } as never),
    ).toBe("https://eventforge.dev");
    expect(
      consoleOriginFor({
        AUTH_CONSOLE_ORIGIN: "http://localhost:5173",
        ENVIRONMENT: "development",
      } as never),
    ).toBe("http://localhost:5173");
    expect(
      consoleOriginFor({
        AUTH_CONSOLE_ORIGIN: "https://dev.eventforge.dev",
        ENVIRONMENT: "preview",
      } as never),
    ).toBe("https://dev.eventforge.dev");
  });
});
