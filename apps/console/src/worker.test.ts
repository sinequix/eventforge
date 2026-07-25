import { describe, expect, it } from "vitest";
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
  // Structural backstop: the static asset in dist/ carries the production keys,
  // and both a production-mode build and a manual `wrangler deploy --env beta`
  // have already shipped it to beta once each. The hostname check means no build
  // or deploy path can leak it again.
  expect(isPreProductionHost("beta.eventforge.dev")).toBe(true);
  expect(isPreProductionHost("eventforge-console-beta.workers.dev")).toBe(true);
  expect(isPreProductionHost("localhost")).toBe(true);
  // Production must keep its real config.
  expect(isPreProductionHost("eventforge.dev")).toBe(false);
  expect(isPreProductionHost("www.eventforge.dev")).toBe(false);

  const response = await worker.fetch(
    new Request("https://beta.eventforge.dev/analytics-config.json"),
    {} as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    posthogKey: "",
    posthogHost: "",
    gaMeasurementId: "",
  });
});
