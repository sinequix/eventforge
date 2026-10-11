import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CopyrightNotice, SiteFooter, SiteLayout } from "./SiteFooter";

function render(node: ReactNode) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function expectSinequixCopyright(container: HTMLElement, year: number) {
  expect(container.textContent).toContain(`© ${year} Sinequix. All rights reserved.`);
  expect(container.textContent).toContain("A Sinequix venture");
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://sinequix.com"]');
  expect(link).not.toBeNull();
  expect(link?.textContent).toBe("Sinequix");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
}

it("uses the current year in the Sinequix copyright", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-06-15T12:00:00Z"));
  const { container, cleanup } = render(<CopyrightNotice />);
  expectSinequixCopyright(container, 2027);
  cleanup();
});

it("renders the shared footer for routes that have no marketing footer", () => {
  const year = new Date().getFullYear();
  const { container, cleanup } = render(<SiteFooter />);
  expect(container.querySelector("footer.ef-site-footer")).not.toBeNull();
  expectSinequixCopyright(container, year);
  cleanup();
});

it("adds the shell footer only when the route does not already include one", () => {
  const year = new Date().getFullYear();
  const withFooter = render(
    <SiteLayout includeFooter>
      <p>Console</p>
    </SiteLayout>,
  );
  expect(withFooter.container.textContent).toContain("Console");
  expectSinequixCopyright(withFooter.container, year);
  withFooter.cleanup();

  const embedded = render(
    <SiteLayout includeFooter={false}>
      <p>Overview</p>
    </SiteLayout>,
  );
  expect(embedded.container.textContent).toContain("Overview");
  expect(embedded.container.querySelector("footer")).toBeNull();
  expect(embedded.container.textContent).not.toContain("Sinequix");
  embedded.cleanup();
});
