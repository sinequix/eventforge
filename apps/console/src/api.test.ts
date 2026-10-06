import { afterEach, describe, expect, it, vi } from "vitest";
import * as signIn from "./SignInPage";
import { api, webhookApi } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.eventforgeDesktop;
});

describe("console API", () => {
  it("loads dashboard events from the configured control plane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })),
    );
    await expect(api.events()).resolves.toEqual([]);
  });

  it("rejects a response that does not satisfy the runtime event contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 })),
    );
    await expect(api.events()).rejects.toThrow("event.provider");
  });

  it("preserves the HTTP status in a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("stale decision", { status: 409 })),
    );
    const operation = api.decideAction("action-1", true);
    await expect(operation).rejects.toMatchObject({ status: 409, message: "stale decision" });
  });

  it("lets the server derive reviewer identity and sends an idempotency key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api.decideAction("action/1", true);
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/actions/action%2F1/decision");
    expect(JSON.parse(String(init.body))).toEqual({ approved: true });
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^action:action\/1:/);
  });

  it("routes desktop requests through the constrained preload bridge", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, body: "[]" });
    window.eventforgeDesktop = {
      localDaemonUrl: "http://127.0.0.1:4311",
      controlPlaneUrl: "http://127.0.0.1:4310",
      platform: "darwin",
      request,
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api.events()).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith("/events", expect.objectContaining({ method: undefined }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls hosted /v1 on the console origin with the request token", async () => {
    vi.spyOn(signIn, "getRequestToken").mockReturnValue("request-token");
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "inst-1",
          workspaceId: "ws-1",
          provider: "custom",
          installationKey: "route-1",
          status: "active",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await webhookApi.createInstallation("ws-1");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/workspaces/ws-1/installations");
    expect(new Headers(init.headers).get("x-eventforge-request-token")).toBe("request-token");
    expect(init.credentials).toBe("include");
  });

  it("sends an audited replay reason on the hosted replay route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, replayed: true, deliveryId: "del-1" }), {
        status: 202,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await webhookApi.replay("ws-1", "del-1", "endpoint recovered after timeout");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/workspaces/ws-1/deliveries/del-1/replay");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "endpoint recovered after timeout" });
  });

  it("surfaces problem details and publishes events with an idempotency key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail:
              "eventType must be 1-128 characters of letters, numbers, dot, underscore, colon, or dash.",
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            duplicate: false,
            eventId: "evt-1",
            deliveryIds: ["del-1"],
            matchedDestinationCount: 1,
          }),
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      webhookApi.createDestination("ws-1", "inst-1", {
        url: "https://example.com/hooks",
        eventTypes: ["*"],
      }),
    ).rejects.toThrow("eventType must be 1-128 characters");
    await webhookApi.publish("ws-1", {
      installationId: "inst-1",
      eventType: "invoice.paid",
      payload: { id: 1 },
    });
    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/v1/workspaces/ws-1/events");
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^publish:inst-1:/);
  });

  it("treats JSON-null optional delivery fields as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "del-1",
                status: "accepted",
                eventId: "evt-1",
                destinationId: "dst-1",
                attemptsCount: 0,
                safeReason: null,
                createdAt: "2026-08-28T21:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(webhookApi.deliveries("ws-1")).resolves.toEqual([
      {
        id: "del-1",
        status: "accepted",
        eventId: "evt-1",
        destinationId: "dst-1",
        attemptsCount: 0,
        safeReason: undefined,
        createdAt: "2026-08-28T21:00:00.000Z",
      },
    ]);
  });

  it("parses API keys when lastUsedAt is JSON null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
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
                lastUsedAt: null,
                createdAt: "2026-08-28T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(webhookApi.apiKeys("ws-1")).resolves.toEqual([
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
        token: undefined,
      },
    ]);
  });
});
