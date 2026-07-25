import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import FeaturesPage from "./FeaturesPage";

vi.mock("./analytics", () => ({ captureEvent: vi.fn() }));

function render() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<FeaturesPage />));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => vi.clearAllMocks());

it("renders every lifecycle stage with a route back to the overview", () => {
  const { container, cleanup } = render();
  for (const id of ["receive", "understand", "decide", "act", "prove"]) {
    expect(container.querySelector(`#${id}`), `stage ${id} must render`).not.toBeNull();
  }
  expect(container.querySelector<HTMLAnchorElement>('a[href="/"]')).not.toBeNull();
  expect(
    container.querySelector<HTMLImageElement>('img[src="/eventforge-mark.svg"]'),
  ).not.toBeNull();
  cleanup();
});

it("states a status on every capability so none reads as implicitly shipped", () => {
  const { container, cleanup } = render();
  const cards = container.querySelectorAll(".ef-feature");
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) {
    const status = card.querySelector(".ef-feature-status");
    expect(status, `"${card.querySelector("h3")?.textContent}" must carry a status`).not.toBeNull();
    expect(status?.textContent?.trim()).toMatch(/Available|Foundation|Planned/);
  }
  cleanup();
});

// The page's value depends on the labels being conservative. A capability with no
// exposed route must not read as usable, so guard the specific ones that were
// corrected after checking the routing table: replay has no route, durable
// delivery ships behind a disabled flag, and hosted identity is gated with
// hosted ingress.
it("does not advertise capabilities that nothing exposes yet as available", () => {
  const { container, cleanup } = render();
  const statusOf = (heading: string) => {
    const card = [...container.querySelectorAll(".ef-feature")].find(
      (node) => node.querySelector("h3")?.textContent === heading,
    );
    expect(card, `expected a card titled "${heading}"`).toBeDefined();
    return card?.querySelector(".ef-feature-status")?.textContent?.trim() ?? "";
  };
  expect(statusOf("Replay with audit")).toContain("Foundation");
  expect(statusOf("Durable delivery queue")).toContain("Foundation");
  expect(statusOf("Workspace and account identity")).toContain("Foundation");
  cleanup();
});

it("scopes the Available claim to self-host rather than the managed service", () => {
  const { container, cleanup } = render();
  const legend = container.querySelector(".ef-maturity-key");
  expect(legend).not.toBeNull();
  // The hosted cloud runs with PUBLIC_INGRESS_ENABLED=false in production, so an
  // unqualified "Available" would read as a managed-service promise the product
  // does not keep. This asserts the qualifier survives future copy edits.
  const available = legend?.querySelector(".ef-maturity--available")?.textContent ?? "";
  expect(available).toContain("self-host");
  expect(available).toContain("fail-closed");
  cleanup();
});

it("labels each legend count with the category it actually describes", () => {
  const { container, cleanup } = render();
  // Guards the render wiring, not the data: a count badge rendered under the
  // wrong maturity key would make the legend misreport the mix. Counts are
  // recomputed here from the cards' own status text.
  const rendered = [...container.querySelectorAll(".ef-feature-status")].reduce<
    Record<string, number>
  >((acc, node) => {
    const label = (node.textContent ?? "").trim();
    return { ...acc, [label]: (acc[label] ?? 0) + 1 };
  }, {});
  for (const item of container.querySelectorAll(".ef-maturity-key-item")) {
    const label = item.querySelector("dt")?.textContent?.replace(/\d+/g, "").trim() ?? "";
    const claimed = Number(item.querySelector(".ef-maturity-count")?.textContent);
    expect(rendered[label], `legend lists "${label}" but no card carries it`).toBe(claimed);
  }
  expect(Object.keys(rendered).length).toBeGreaterThan(1);
  cleanup();
});
