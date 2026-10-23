import { describe, expect, it, vi } from "vitest";
import worker, { isConsolePath, isPreProductionHost } from "./worker.js";

describe("hosted console route boundary", () => {
  it("protects the console document and every nested console route", () => {
    expect(isConsolePath("/console")).toBe(true);
    expect(isConsolePath("/console/settings")).toBe(true);
    expect(isConsolePath("/console-public")).toBe(false);
    expect(isConsolePath("/")).toBe(false);
  });

  it("negotiates Markdown and publishes discovery links on the public homepage", async () => {
    const assets = { fetch: async () => new Response("<html>homepage</html>") };
    const markdown = await worker.fetch(
      new Request("https://eventforge.dev/", { headers: { accept: "text/markdown" } }),
      { ASSETS: assets },
    );
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("# EventForge");

    const homepage = await worker.fetch(new Request("https://eventforge.dev/"), { ASSETS: assets });
    expect(homepage.headers.get("link")).toContain('rel="sitemap"');
  });
});

it("serves a blanked analytics config on any non-production host", async () => {
  // Structural backstop: the static asset in dist/ carries the production keys.
  // The hostname check means no build or deploy path can leak it to a
  // non-production host.
  expect(isPreProductionHost("localhost")).toBe(true);
  expect(isPreProductionHost("eventforge-console.workers.dev")).toBe(true);
  expect(isPreProductionHost("eventforge.dev")).toBe(false);
  expect(isPreProductionHost("www.eventforge.dev")).toBe(false);

  const response = await worker.fetch(
    new Request("https://localhost/analytics-config.json"),
    {} as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    posthogKey: "",
    posthogHost: "",
    gaMeasurementId: "",
  });
});

it("serves the console SPA on production instead of a sign-in gate", async () => {
  const assets = { fetch: async () => new Response("<html>console</html>") };
  const response = await worker.fetch(new Request("https://eventforge.dev/console"), {
    ASSETS: assets,
    API_ORIGIN: "https://api.eventforge.dev",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("console");
});

it("proxies /api on production so the session cookie can stay SameSite=Strict", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ captchaRequired: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock;
  try {
    const response = await worker.fetch(new Request("https://eventforge.dev/api/auth/config"), {
      ASSETS: { fetch: async () => new Response("assets") },
      API_ORIGIN: "https://api.eventforge.dev",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const upstream = fetchMock.mock.calls[0]![0] as Request;
    expect(new URL(upstream.url).href).toBe("https://api.eventforge.dev/api/auth/config");
    expect(await response.json()).toEqual({ captchaRequired: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
