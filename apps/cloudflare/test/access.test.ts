import { describe, expect, it } from "vitest";
import {
  canAccessResource,
  hasPresentedCredentials,
  ownsWorkspace,
  permissionAllows,
  type Access,
  type ApiKeyPermissions,
} from "../src/access.js";

const session = (role: "owner" | "admin" | "operator" | "viewer"): Access => ({
  kind: "session",
  identityId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  memberships: [{ workspaceId: "ws-1", role, version: 1 }],
});

const key = (permissions: ApiKeyPermissions): Access => ({
  kind: "api_key",
  keyId: "key-1",
  workspaceId: "ws-1",
  permissions,
});

describe("v1 access", () => {
  it("treats missing credentials as ungated probes and bearer/session as presented", () => {
    expect(hasPresentedCredentials(new Request("https://api.eventforge.dev/v1/events"))).toBe(
      false,
    );
    expect(
      hasPresentedCredentials(
        new Request("https://api.eventforge.dev/v1/events", {
          headers: { authorization: "Bearer efk_ab" },
        }),
      ),
    ).toBe(true);
    expect(
      hasPresentedCredentials(
        new Request("https://api.eventforge.dev/v1/events", {
          headers: {
            cookie: "ef_session=a.b",
            "x-eventforge-request-token": "token",
          },
        }),
      ),
    ).toBe(true);
  });

  it("re-checks workspace ownership and never lets an API key manage API keys", () => {
    expect(ownsWorkspace(session("viewer"), "ws-1")).toBe(true);
    expect(ownsWorkspace(session("viewer"), "ws-other")).toBe(false);
    expect(
      ownsWorkspace(
        key({ events: "write", destinations: "none", deliveries: "none", replay: "none" }),
        "ws-1",
      ),
    ).toBe(true);
    expect(
      canAccessResource(
        key({ events: "write", destinations: "none", deliveries: "none", replay: "none" }),
        "ws-1",
        "api_keys",
        "write",
      ),
    ).toBe(false);
  });

  it("maps session roles and API key permissions onto resource verbs", () => {
    expect(canAccessResource(session("viewer"), "ws-1", "destinations", "read")).toBe(true);
    expect(canAccessResource(session("viewer"), "ws-1", "destinations", "write")).toBe(false);
    expect(canAccessResource(session("operator"), "ws-1", "events", "write")).toBe(true);
    expect(canAccessResource(session("operator"), "ws-1", "api_keys", "write")).toBe(false);
    expect(canAccessResource(session("admin"), "ws-1", "api_keys", "write")).toBe(true);
    expect(canAccessResource(session("viewer"), "ws-1", "replay", "write")).toBe(false);
    expect(canAccessResource(session("operator"), "ws-1", "replay", "write")).toBe(true);
    expect(canAccessResource(session("operator"), "ws-1", "members", "write")).toBe(false);
    expect(canAccessResource(session("admin"), "ws-1", "members", "write")).toBe(true);
    expect(
      canAccessResource(
        key({ events: "write", destinations: "write", deliveries: "write", replay: "write" }),
        "ws-1",
        "members",
        "write",
      ),
    ).toBe(false);
    const none = key({
      events: "none",
      destinations: "none",
      deliveries: "none",
      replay: "none",
    });
    expect(canAccessResource(none, "ws-1", "events", "write")).toBe(false);
    expect(permissionAllows("none", "read")).toBe(false);
    expect(permissionAllows("read", "read")).toBe(true);
    expect(permissionAllows("read", "write")).toBe(false);
    expect(permissionAllows("write", "read")).toBe(true);
    const writer = key({
      events: "write",
      destinations: "read",
      deliveries: "write",
      replay: "write",
    });
    expect(canAccessResource(writer, "ws-1", "events", "write")).toBe(true);
    expect(canAccessResource(writer, "ws-1", "destinations", "write")).toBe(false);
    expect(canAccessResource(writer, "other", "events", "write")).toBe(false);
  });
});
