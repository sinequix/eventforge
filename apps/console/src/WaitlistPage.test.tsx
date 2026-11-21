import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WaitlistForm } from "./WaitlistPage";
import { captureEvent } from "./analytics";

vi.mock("./analytics", () => ({ captureEvent: vi.fn() }));

function renderForm() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<WaitlistForm source="landing" idPrefix="test" />));
  return {
    container,
    form: container.querySelector<HTMLFormElement>("form")!,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function submit(form: HTMLFormElement, values: { email?: string; consent?: boolean }) {
  const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]')!;
  const consentInput = form.querySelector<HTMLInputElement>('input[name="consent"]')!;
  emailInput.value = values.email ?? "";
  consentInput.checked = values.consent === true;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not start a waitlist capture when email or consent is missing", async () => {
  const { form, container, cleanup } = renderForm();
  await submit(form, { email: "not-an-email", consent: true });
  expect(captureEvent).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Enter a valid email address.");

  await submit(form, { email: "you@company.com", consent: false });
  expect(captureEvent).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Consent is required to join the waitlist.");
  cleanup();
});

it("records API failures with error, status and code", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        accepted: false,
        detail: "Enter a valid email address.",
        code: "INVALID_EMAIL",
      }),
      { status: 400, headers: { "content-type": "application/problem+json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { form, cleanup } = renderForm();
  await submit(form, { email: "you@company.com", consent: true });
  expect(captureEvent).toHaveBeenNthCalledWith(1, "waitlist_submit_started", { source: "landing" });
  expect(captureEvent).toHaveBeenNthCalledWith(2, "waitlist_submit_failed", {
    error: "Enter a valid email address.",
    status: 400,
    code: "INVALID_EMAIL",
  });
  cleanup();
});

it("records a successful waitlist join", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, alreadyRegistered: false }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  const { form, container, cleanup } = renderForm();
  await submit(form, { email: "you@company.com", consent: true });
  expect(captureEvent).toHaveBeenNthCalledWith(1, "waitlist_submit_started", { source: "landing" });
  expect(captureEvent).toHaveBeenNthCalledWith(2, "waitlist_submitted", {
    already_registered: false,
  });
  expect(container.textContent).toContain("You are on the list.");
  cleanup();
});
