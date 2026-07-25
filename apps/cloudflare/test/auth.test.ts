import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  hashToken,
  parseCookie,
  parseSessionCookieValue,
  rankOf,
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
