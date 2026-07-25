import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve("index.html"), "utf8");
const responseHeaders = readFileSync(resolve("public/_headers"), "utf8");

const analyticsSources = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googletagmanager.com",
  "https://static.cloudflareinsights.com",
  "https://cloudflareinsights.com",
];

describe("console content security policies", () => {
  // Turnstile loads a script from challenges.cloudflare.com and renders the
  // challenge in an iframe. Without both directives the login page silently shows
  // no captcha, and the server then rejects every sign-in for a missing token —
  // a broken login that looks like bad credentials.
  it("allows the Turnstile script and frame in both browser policies", () => {
    for (const policy of [indexHtml, responseHeaders]) {
      expect(policy).toContain("https://challenges.cloudflare.com");
      expect(policy).toMatch(/frame-src[^;]*challenges\.cloudflare\.com/);
      expect(policy).toMatch(/script-src[^;]*challenges\.cloudflare\.com/);
    }
  });

  it("allows the production analytics endpoints in both browser policies", () => {
    for (const source of analyticsSources) {
      expect(indexHtml).toContain(source);
      expect(responseHeaders).toContain(source);
    }
  });

  it("enforces frame ancestors only through the HTTP response header", () => {
    expect(indexHtml).not.toContain("frame-ancestors");
    expect(responseHeaders).toContain("frame-ancestors 'none'");
  });
});
