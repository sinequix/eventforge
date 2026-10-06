import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ADMIN_VIEWS } from "./views";

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

const mockApi = vi.hoisted(() => ({
  events: vi.fn(),
  actions: vi.fn(),
  runs: vi.fn(),
  audit: vi.fn(),
  memory: vi.fn(),
  connectors: vi.fn(),
  forges: vi.fn(),
  demo: vi.fn(),
  decideAction: vi.fn(),
  forge: vi.fn(),
  decideForge: vi.fn(),
}));

vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  webhookApi: mockWebhookApi,
  api: mockApi,
}));

import AdminDashboard from "./AdminDashboard";

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
  mockWebhookApi.destinations.mockResolvedValue([]);
  mockWebhookApi.deliveries.mockResolvedValue([]);
  mockWebhookApi.members.mockResolvedValue([]);
  mockWebhookApi.apiKeys.mockResolvedValue([
    {
      id: "key-1",
      workspaceId: "ws-1",
      name: "ci",
      prefix: "efk_abc123xy",
      permissions: {
        events: "write",
        destinations: "read",
        deliveries: "read",
        replay: "none",
      },
      lastUsedAt: undefined,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ]);
  for (const fn of Object.values(mockApi)) fn.mockResolvedValue([]);
}

async function renderDashboard(session = ownerSession) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminDashboard onSignedOut={() => undefined} session={session} />);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h2")].map((node) => node.textContent ?? "");
}

function sidebarButton(container: HTMLElement, label: string): HTMLButtonElement {
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  const found = [...(nav?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes(label),
  );
  if (!found) throw new Error(`Sidebar item not found: ${label}`);
  return found as HTMLButtonElement;
}

it("lists admin views in a sidebar and shows only the selected view", async () => {
  mockLists();
  const { container, unmount } = await renderDashboard();
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav).toBeTruthy();
  for (const view of ADMIN_VIEWS) expect(nav!.textContent).toContain(view.label);

  expect(headings(container)).toEqual(["Routes"]);
  expect(container.textContent).toContain("New route");

  for (const view of ADMIN_VIEWS) {
    await act(async () => {
      sidebarButton(container, view.label).click();
    });
    const visible = headings(container);
    expect(visible, `${view.label} must show its heading`).toContain(view.heading);
    for (const other of ADMIN_VIEWS) {
      if (other.id === view.id) continue;
      expect(visible, `${view.label} must hide ${other.label}`).not.toContain(other.heading);
    }
  }
  unmount();
});

it("renders API keys with a null lastUsedAt as never used", async () => {
  mockLists();
  const { container, unmount } = await renderDashboard();
  await act(async () => {
    sidebarButton(container, "API keys").click();
  });
  expect(headings(container)).toContain("API keys");
  expect(container.textContent).toContain("ci");
  expect(container.textContent).toContain("efk_abc123xy");
  expect(container.textContent).toContain("Never used");
  expect(container.textContent).toContain("Create key");
  unmount();
});
