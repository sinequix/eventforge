import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WaitlistForm } from "./WaitlistPage";

vi.mock("./analytics", () => ({ captureEvent: vi.fn() }));

it("keeps a persisted signup successful after the asynchronous submit and uses the local proxy", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ accepted: true }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WaitlistForm source="test" idPrefix="test" />));
    container.querySelector<HTMLInputElement>('input[type="email"]')!.value = "test@example.test";
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/waitlist");
    expect(container.textContent).toContain("You are on the list.");
    expect(container.textContent).not.toContain("Cannot read");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
