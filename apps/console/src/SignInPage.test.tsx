import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import SignInPage from "./SignInPage";

it("can return from email recovery to password sign-in after removing the captcha widget", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json({ captchaRequired: true })),
  );
  const render = vi.fn(() => "captcha-widget");
  window.turnstile = {
    render,
    remove: vi.fn(),
    reset: (id) => {
      if (!id) throw new Error("No widget to reset");
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === text,
    )!;
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<SignInPage onSignedIn={() => undefined} />));
    expect(render).toHaveBeenCalledTimes(1);
    await click("Forgot your password? Sign in by email");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await click("Use a password");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(render).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    delete window.turnstile;
    vi.unstubAllGlobals();
  }
});
