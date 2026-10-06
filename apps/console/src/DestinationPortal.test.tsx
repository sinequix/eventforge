import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mockWebhookApi = vi.hoisted(() => ({
  installations: vi.fn(),
  createInstallation: vi.fn(),
  destinations: vi.fn(),
  createDestination: vi.fn(),
  deliveries: vi.fn(),
  replay: vi.fn(),
  publish: vi.fn(),
  members: vi.fn(),
  invite: vi.fn(),
  apiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  webhookApi: mockWebhookApi,
}));

import DestinationPortal from "./DestinationPortal";

const ownerSession = {
  identity: { id: "id-1", email: "ops@example.com" },
  memberships: [{ workspaceId: "ws-1", role: "owner", version: 1 }],
  capabilities: {},
};

afterEach(() => vi.clearAllMocks());

function mockLists() {
  mockWebhookApi.installations.mockResolvedValue([
    {
      id: "inst-1",
      workspaceId: "ws-1",
      provider: "custom",
      installationKey: "route-key",
      status: "active",
    },
  ]);
  mockWebhookApi.destinations.mockResolvedValue([
    {
      id: "dest-1",
      workspaceId: "ws-1",
      installationId: "inst-1",
      url: "https://example.com/hooks",
      description: "",
      eventTypes: ["*"],
      channels: [],
      maxRatePerSecond: 10,
      mode: "best_effort",
      status: "active",
      secretHint: "abcd",
    },
  ]);
  mockWebhookApi.deliveries.mockResolvedValue([
    {
      id: "del-1",
      status: "stored",
      attemptsCount: 0,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ]);
  mockWebhookApi.members.mockResolvedValue([
    {
      identityId: "id-1",
      email: "ops@example.com",
      role: "owner",
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ]);
  mockWebhookApi.apiKeys.mockResolvedValue([]);
}

async function renderPortal(session = ownerSession) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DestinationPortal onSignedOut={() => undefined} session={session} />);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function openView(container: HTMLElement, label: string) {
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  const button = [...(nav?.querySelectorAll("button") ?? [])].find((item) =>
    item.textContent?.includes(label),
  );
  if (!button) throw new Error(`Sidebar item not found: ${label}`);
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
}

it("loads routes, endpoints, and deliveries for the signed-in workspace", async () => {
  mockLists();
  const { container, unmount } = await renderPortal();
  expect(mockWebhookApi.installations).toHaveBeenCalledWith("ws-1");
  expect(container.textContent).toContain("New route");
  await openView(container, "Endpoints");
  expect(mockWebhookApi.destinations).toHaveBeenCalledWith("ws-1", "inst-1");
  expect(container.textContent).toContain("https://example.com/hooks");
  await openView(container, "Deliveries");
  expect(mockWebhookApi.deliveries).toHaveBeenCalledWith("ws-1");
  expect(container.textContent).toContain("stored");
  await openView(container, "Members");
  expect(mockWebhookApi.members).toHaveBeenCalledWith("ws-1");
  expect(container.textContent).toContain("ops@example.com");
  unmount();
});

it("creates a route from the Routes view", async () => {
  mockLists();
  mockWebhookApi.createInstallation.mockResolvedValue({
    id: "inst-2",
    workspaceId: "ws-1",
    provider: "custom",
    installationKey: "new-route",
    status: "active",
  });
  const { container, unmount } = await renderPortal();
  const create = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("New route"),
  );
  await act(async () => {
    create!.click();
  });
  expect(mockWebhookApi.createInstallation).toHaveBeenCalledWith("ws-1");
  unmount();
});

it("creates an endpoint from the Endpoints view", async () => {
  mockLists();
  mockWebhookApi.createDestination.mockResolvedValue({
    id: "dest-2",
    workspaceId: "ws-1",
    installationId: "inst-1",
    url: "https://example.com/webhooks/eventforge",
    description: "",
    eventTypes: [],
    channels: [],
    maxRatePerSecond: 10,
    mode: "best_effort",
    status: "active",
    secretHint: "wxyz",
    secret: "whsec_test",
  });
  const { container, unmount } = await renderPortal();
  await openView(container, "Endpoints");
  const form = container.querySelector("#destination-url")?.closest("form");
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mockWebhookApi.createDestination).toHaveBeenCalledWith("ws-1", "inst-1", {
    url: "https://example.com/webhooks/eventforge",
  });
  expect(container.textContent).toContain("whsec_test");
  unmount();
});

it("asks for a replay reason before calling replay", async () => {
  mockLists();
  mockWebhookApi.replay.mockResolvedValue({ accepted: true, replayed: true, deliveryId: "del-1" });
  const { container, unmount } = await renderPortal();
  await openView(container, "Deliveries");
  const replay = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Replay"),
  );
  expect(replay).toBeDefined();
  await act(async () => {
    replay!.click();
  });
  const reason = container.querySelector("#replay-reason") as HTMLTextAreaElement;
  expect(reason).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
      reason,
      "endpoint recovered after timeout",
    );
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const confirm = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Confirm replay"),
  );
  await act(async () => {
    confirm!.click();
  });
  expect(mockWebhookApi.replay).toHaveBeenCalledWith(
    "ws-1",
    "del-1",
    "endpoint recovered after timeout",
  );
  unmount();
});

it("invites a member for an owner workspace", async () => {
  mockLists();
  mockWebhookApi.invite.mockResolvedValue({
    id: "inv-1",
    workspaceId: "ws-1",
    email: "new@example.com",
    role: "operator",
  });
  const { container, unmount } = await renderPortal();
  await openView(container, "Members");
  const email = container.querySelector("#invite-email") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      email,
      "new@example.com",
    );
    email.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = email.closest("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mockWebhookApi.invite).toHaveBeenCalledWith("ws-1", {
    email: "new@example.com",
    role: "operator",
  });
  unmount();
});

it("publishes a test event for the selected route", async () => {
  mockLists();
  mockWebhookApi.publish.mockResolvedValue({
    accepted: true,
    duplicate: false,
    eventId: "evt-9",
    deliveryIds: ["del-1"],
    matchedDestinationCount: 1,
  });
  const { container, unmount } = await renderPortal();
  await openView(container, "Send event");
  const form = container.querySelector("#publish-payload")?.closest("form");
  expect(form).toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mockWebhookApi.publish).toHaveBeenCalledWith("ws-1", {
    installationId: "inst-1",
    eventType: "invoice.paid",
    payload: { id: "evt_test" },
  });
  expect(container.textContent).toContain("Accepted event evt-9");
  unmount();
});

it("creates an API key from the API keys view", async () => {
  mockLists();
  mockWebhookApi.createApiKey.mockResolvedValue({
    id: "key-2",
    workspaceId: "ws-1",
    name: "publisher",
    prefix: "efk_newkey12",
    permissions: {
      events: "write",
      destinations: "write",
      deliveries: "read",
      replay: "none",
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    token: "efk_secret",
  });
  const { container, unmount } = await renderPortal();
  await openView(container, "API keys");
  const form = container.querySelector("#api-key-name")?.closest("form");
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mockWebhookApi.createApiKey).toHaveBeenCalledWith("ws-1", {
    name: "publisher",
    permissions: {
      events: "write",
      destinations: "write",
      deliveries: "read",
      replay: "none",
    },
  });
  expect(container.textContent).toContain("efk_secret");
  unmount();
});

it("sends operators to the waitlist when they have no workspace", async () => {
  const { container, unmount } = await renderPortal({
    identity: { id: "id-1", email: "ops@example.com" },
    memberships: [],
    capabilities: {},
  });
  expect(container.textContent).toContain("Join the waitlist");
  expect(mockWebhookApi.installations).not.toHaveBeenCalled();
  unmount();
});
