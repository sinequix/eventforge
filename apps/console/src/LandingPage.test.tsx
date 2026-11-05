import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  expect(container.textContent).toContain("Let your agent react to real webhooks.");
  expect(container.textContent).toContain(
    "EventForge checks the signature. Forged events are rejected, unsigned ones are flagged, and only verified events get injected into your agent's context.",
  );
  expect(container.textContent).toContain("Open source. Made by Sinequix in Tandil, Argentina.");
  expect(container.querySelector("#hermes")).not.toBeNull();
  expect(container.querySelector('a[href="#hermes"]')).not.toBeNull();
  expect(
    container.querySelector('a[href="https://github.com/NousResearch/hermes-agent/pull/149194"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("hermes plugins enable eventforge");
  expect(container.textContent).not.toContain("hermes plugins install");
  expect(container.textContent).not.toContain("tebayoso");
  expect(container.textContent).toContain("Agents start with context");
  expect(container.textContent).toContain("Verified ingress");
  expect(container.textContent).toContain("Free to prove.");
  expect(container.textContent).toContain("Codex MCP");
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

it("publishes an llms.txt that matches the approved home copy", () => {
  const llms = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");
  expect(llms.startsWith("# EventForge\n")).toBe(true);
  expect(llms).toContain("only verified events get injected into your agent's context.");
  expect(llms).toContain("https://github.com/sinequix/eventforge");
  expect(llms).not.toContain("tebayoso");
  expect(llms).not.toContain("hermes plugins install");
  expect(llms).not.toContain("\u2014");
});
