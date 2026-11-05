import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import LandingPage from "./LandingPage";

it("renders the public product story and working console entrypoint", () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<LandingPage />));
  expect(container.querySelector<HTMLAnchorElement>('a[href="/console"]')).not.toBeNull();
  expect(container.textContent).toContain("EventForge");
  expect(
    container.querySelector<HTMLImageElement>('img[src="/eventforge-mark.svg"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("Agents start with context");
  expect(container.textContent).toContain("Verified ingress");
  expect(container.textContent).toContain("Free to prove.");
  expect(container.textContent).toContain("Install with Codex");
  expect(container.textContent).toContain("Join the waitlist");
  expect(container.textContent).toContain("Sign-in is live.");
  expect(container.querySelector("#waitlist")).not.toBeNull();
  expect(container.querySelector<HTMLFormElement>("#waitlist form")).not.toBeNull();
  expect(
    container.querySelector<HTMLAnchorElement>('a[href="https://github.com/sinequix/eventforge"]'),
  ).not.toBeNull();
  expect(
    container.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/sinequix/eventforge/blob/master/workfiles/CONFIGURATION.md"]',
    ),
  ).not.toBeNull();
  act(() => root.unmount());
  container.remove();
});
