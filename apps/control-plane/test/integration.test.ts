import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventForgeStore } from "@eventforge/core";
import {
  PROPOSAL_PENDING_NOTE,
  configuredAllowedRepositories,
  configuredCiWorkflowNames,
  createApp,
  createWorkflowRunFailureWorkflow,
} from "../src/app.js";
import {
  WebhookNotifier,
  createNotifierFromEnv,
  signNotification,
  validateNotifyUrl,
  type RunNotification,
} from "../src/notify.js";
import type { AgentRunner } from "../src/runner.js";

const SECRET = "integration-webhook-secret";
const NOTIFY_SECRET = "integration-notify-secret";
const runner: AgentRunner = {
  investigate: async () => ({ threadId: "t-1", summary: "CI failed on a missing null guard." }),
};
const touched = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!touched.has(key)) touched.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
});

type Captured = { url: string; init: RequestInit };

function recordingNotifier(responses: Array<number | Error> = []) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
  const logs: string[] = [];
  const log = {
    info: (object: Record<string, unknown>, message: string) =>
      logs.push(JSON.stringify(object) + message),
    warn: (object: Record<string, unknown>, message: string) =>
      logs.push(JSON.stringify(object) + message),
  };
  const notifier = new WebhookNotifier({
    url: "https://hooks.example.test/eventforge?token=hidden",
    secret: NOTIFY_SECRET,
    fetch: fetchImpl as unknown as typeof fetch,
    baseDelayMs: 0,
    log,
  });
  return { notifier, calls, logs, fetchImpl };
}

function bodies(calls: Captured[]): RunNotification[] {
  return calls.map((call) => JSON.parse(String(call.init.body)) as RunNotification);
}

async function deliver(
  app: Awaited<ReturnType<typeof createApp>>,
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
) {
  const body = JSON.stringify(payload);
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return response;
}

const checkRunFailure = (repository: string) => ({
  action: "completed",
  check_run: {
    conclusion: "failure",
    name: "test",
    html_url: `https://github.com/${repository}/runs/1`,
  },
  repository: { full_name: repository },
});

const workflowRun = (repository: string, conclusion: string, name = "Quality") => ({
  action: "completed",
  workflow_run: {
    id: 99,
    name,
    conclusion,
    html_url: `https://github.com/${repository}/actions/runs/99`,
  },
  repository: { full_name: repository },
});

describe("repository allowlist configuration", () => {
  it("prefers EVENTFORGE_ALLOWED_REPOS, then the configured repository, then the demo", () => {
    expect(
      configuredAllowedRepositories({ EVENTFORGE_ALLOWED_REPOS: " a/b , c/d ", NODE_ENV: "x" }),
    ).toEqual(["a/b", "c/d"]);
    expect(
      configuredAllowedRepositories({ EVENTFORGE_GITHUB_REPOSITORY: "sinequix/eventforge" }),
    ).toEqual(["sinequix/eventforge"]);
    expect(configuredAllowedRepositories({ GITHUB_REPOSITORY: "sinequix/eventforge" })).toEqual([
      "sinequix/eventforge",
    ]);
    expect(
      configuredAllowedRepositories({
        EVENTFORGE_GITHUB_REPOSITORY: "owner/configured",
        GITHUB_REPOSITORY: "owner/runner",
      }),
    ).toEqual(["owner/configured"]);
    expect(configuredAllowedRepositories({ GITHUB_REPOSITORY: "not a repo" })).toEqual([
      "eventforge/demo-service",
    ]);
    expect(configuredAllowedRepositories({})).toEqual(["eventforge/demo-service"]);
    expect(
      configuredAllowedRepositories({
        EVENTFORGE_ALLOWED_REPOS: "a/b",
        EVENTFORGE_DEMO_MODE: "true",
      }),
    ).toEqual(["a/b", "eventforge/demo-service"]);
    expect(() => configuredAllowedRepositories({ EVENTFORGE_ALLOWED_REPOS: "not a repo" })).toThrow(
      "OWNER/REPOSITORY",
    );
  });

  it("parses optional CI workflow names into a workflow_run filter", () => {
    expect(configuredCiWorkflowNames({ EVENTFORGE_CI_WORKFLOWS: "Quality, CodeQL" })).toEqual([
      "Quality",
      "CodeQL",
    ]);
    expect(createWorkflowRunFailureWorkflow(["a/b"], ["Quality"]).filters).toEqual({
      action: "completed",
      "workflow_run.conclusion": "failure",
      "workflow_run.name": ["Quality"],
    });
    expect(createWorkflowRunFailureWorkflow(["a/b"], []).filters).not.toHaveProperty(
      "workflow_run.name",
    );
  });
});

describe("verified GitHub CI failures on a real repository", () => {
  it("evaluates policy on the payload repository and keeps the summary coherent", async () => {
    setEnv({
      GITHUB_WEBHOOK_SECRET: SECRET,
      EVENTFORGE_ALLOWED_REPOS: "sinequix/eventforge",
      EVENTFORGE_GITHUB_REPOSITORY: "someone/else",
    });
    const { notifier, calls } = recordingNotifier();
    const app = await createApp({
      store: new EventForgeStore(),
      runner,
      persistAudit: false,
      notifier,
    });
    try {
      expect(
        (await deliver(app, "check_run", checkRunFailure("sinequix/eventforge"), "d-1")).statusCode,
      ).toBe(202);
      const event = (await app.inject({ method: "GET", url: "/events" })).json()[0];
      expect(event).toMatchObject({
        repository: "sinequix/eventforge",
        signatureStatus: "verified",
      });
      const [run] = (await app.inject({ method: "GET", url: "/runs" })).json();
      expect(run.status).toBe("waiting_for_approval");
      expect(run.summary).toContain(PROPOSAL_PENDING_NOTE);
      expect(run.summary).not.toContain("Policy denied");
      const [action] = (await app.inject({ method: "GET", url: "/actions" })).json();
      expect(action).toMatchObject({
        type: "open_pull_request",
        resources: { repository: "sinequix/eventforge" },
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/actions/${action.id}/decision`,
        payload: { approved: false, version: 1, reason: "not now" },
      });
      expect(rejected.statusCode).toBe(200);
      const [after] = (await app.inject({ method: "GET", url: "/runs" })).json();
      expect(after.summary).toBe(
        "CI failed on a missing null guard. Proposal rejected; no write was performed.",
      );
      await notifier.drain();
      expect(bodies(calls).map((body) => body.status)).toEqual([
        "waiting_for_approval",
        "rejected",
      ]);
      expect(bodies(calls)[0]).toMatchObject({
        repo: "sinequix/eventforge",
        link: "https://github.com/sinequix/eventforge/runs/1",
        proposal: { id: action.id, status: "pending" },
        event: { provider: "github", topic: "check_run", deliveryId: "d-1" },
      });
      expect(bodies(calls)[1].proposal).toMatchObject({ status: "rejected" });
    } finally {
      await app.close();
    }
  });

  it("denies repositories outside the allowlist without claiming a proposal exists", async () => {
    setEnv({ GITHUB_WEBHOOK_SECRET: SECRET, EVENTFORGE_ALLOWED_REPOS: "sinequix/eventforge" });
    const { notifier, calls } = recordingNotifier();
    const app = await createApp({
      store: new EventForgeStore(),
      runner,
      persistAudit: false,
      notifier,
    });
    try {
      await deliver(app, "check_run", checkRunFailure("evil/repo"), "d-2");
      const [run] = (await app.inject({ method: "GET", url: "/runs" })).json();
      expect(run.status).toBe("completed");
      expect(run.summary).toContain("Policy denied the proposal");
      expect(run.summary).not.toContain("waiting for approval");
      expect(run.summary).not.toContain("ready for approval");
      expect((await app.inject({ method: "GET", url: "/actions" })).json()).toEqual([]);
      await notifier.drain();
      expect(bodies(calls)).toMatchObject([
        { status: "completed", proposal: null, repo: "evil/repo" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("handles failed workflow_run deliveries and approves them coherently", async () => {
    setEnv({
      GITHUB_WEBHOOK_SECRET: SECRET,
      EVENTFORGE_ALLOWED_REPOS: "sinequix/eventforge",
      EVENTFORGE_CI_WORKFLOWS: "Quality",
    });
    const { notifier, calls } = recordingNotifier();
    const app = await createApp({
      store: new EventForgeStore(),
      runner,
      persistAudit: false,
      notifier,
    });
    try {
      await deliver(app, "workflow_run", workflowRun("sinequix/eventforge", "success"), "w-ok");
      await deliver(
        app,
        "workflow_run",
        workflowRun("sinequix/eventforge", "failure", "Docs"),
        "w-o",
      );
      await deliver(
        app,
        "push",
        { ref: "refs/heads/master", repository: { full_name: "sinequix/eventforge" } },
        "p-1",
      );
      expect((await app.inject({ method: "GET", url: "/runs" })).json()).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/events" })).json()).toHaveLength(3);

      await deliver(app, "workflow_run", workflowRun("sinequix/eventforge", "failure"), "w-bad");
      const [run] = (await app.inject({ method: "GET", url: "/runs" })).json();
      expect(run.status).toBe("waiting_for_approval");
      const [action] = (await app.inject({ method: "GET", url: "/actions" })).json();
      expect(action.type).toBe("open_pull_request");
      await app.inject({
        method: "POST",
        url: `/actions/${action.id}/decision`,
        payload: { approved: true, version: 1 },
      });
      const [after] = (await app.inject({ method: "GET", url: "/runs" })).json();
      expect(after.summary).not.toContain(PROPOSAL_PENDING_NOTE);
      expect(after.summary).toContain("Proposal approved");
      await notifier.drain();
      expect(bodies(calls).map((body) => [body.status, body.link])).toEqual([
        ["waiting_for_approval", "https://github.com/sinequix/eventforge/actions/runs/99"],
        ["approved", "https://github.com/sinequix/eventforge/actions/runs/99"],
      ]);
    } finally {
      await app.close();
    }
  });

  it("acknowledges webhooks even when the notification endpoint hangs", async () => {
    setEnv({ GITHUB_WEBHOOK_SECRET: SECRET, EVENTFORGE_ALLOWED_REPOS: "sinequix/eventforge" });
    const hanging = vi.fn(() => new Promise<Response>(() => undefined));
    const notifier = new WebhookNotifier({
      url: "https://hooks.example.test/x",
      secret: NOTIFY_SECRET,
      fetch: hanging as unknown as typeof fetch,
    });
    const app = await createApp({
      store: new EventForgeStore(),
      runner,
      persistAudit: false,
      notifier,
    });
    try {
      const response = await deliver(
        app,
        "check_run",
        checkRunFailure("sinequix/eventforge"),
        "h-1",
      );
      expect(response.statusCode).toBe(202);
      const [action] = (await app.inject({ method: "GET", url: "/actions" })).json();
      const decision = await app.inject({
        method: "POST",
        url: `/actions/${action.id}/decision`,
        payload: { approved: true, version: 1 },
      });
      expect(decision.statusCode).toBe(200);
      expect(hanging).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe("local API token", () => {
  it("requires the bearer token for API routes but not for signed webhooks or health", async () => {
    setEnv({ GITHUB_WEBHOOK_SECRET: SECRET, EVENTFORGE_API_TOKEN: "local-api-token-123" });
    const app = await createApp({
      store: new EventForgeStore(),
      runner,
      persistAudit: false,
      notifier: null,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/events" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/events",
            headers: { authorization: "Bearer wrong-token-value" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/events",
            headers: { authorization: "Bearer local-api-token-123" },
          })
        ).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(
        (await deliver(app, "check_run", checkRunFailure("eventforge/demo-service"), "t-1"))
          .statusCode,
      ).toBe(202);
    } finally {
      await app.close();
    }
  });
});

describe("WebhookNotifier", () => {
  const sample: RunNotification = {
    event: { id: "e", provider: "github", topic: "check_run", signatureStatus: "verified" },
    run: { id: "r", workflowId: "w", status: "completed" },
    proposal: null,
    repo: "sinequix/eventforge",
    status: "completed",
    link: null,
  };

  it("signs timestamp.body with HMAC-SHA256 and sends delivery metadata", async () => {
    const { notifier, calls } = recordingNotifier();
    const id = notifier.notify(sample);
    await notifier.drain();
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    const body = String(calls[0].init.body);
    expect(headers["x-eventforge-delivery"]).toBe(id);
    expect(headers["x-eventforge-timestamp"]).toMatch(/^\d+$/);
    expect(headers["x-eventforge-signature"]).toBe(
      signNotification(NOTIFY_SECRET, headers["x-eventforge-timestamp"], body),
    );
    expect(headers["x-eventforge-signature"]).toBe(
      `sha256=${createHmac("sha256", NOTIFY_SECRET).update(`${headers["x-eventforge-timestamp"]}.${body}`).digest("hex")}`,
    );
    expect(JSON.parse(body)).toEqual(sample);
  });

  it("retries 5xx, 429 and network errors with exponential backoff, keeping the delivery id", async () => {
    const delays: number[] = [];
    const responses: Array<number | Error> = [500, 429, new TypeError("fetch failed"), 204];
    const calls: Captured[] = [];
    const notifier = new WebhookNotifier({
      url: "https://hooks.example.test/x",
      secret: NOTIFY_SECRET,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses.shift()!;
        if (next instanceof Error) throw next;
        return new Response(null, { status: next });
      }) as unknown as typeof fetch,
    });
    notifier.notify(sample);
    await notifier.drain();
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([100, 200, 400]);
    const ids = new Set(
      calls.map((call) => (call.init.headers as Record<string, string>)["x-eventforge-delivery"]),
    );
    expect(ids.size).toBe(1);
  });

  it("does not retry other 4xx responses and gives up after maxAttempts", async () => {
    const rejected = recordingNotifier([400]);
    rejected.notifier.notify(sample);
    await rejected.notifier.drain();
    expect(rejected.calls).toHaveLength(1);

    const failing = recordingNotifier([503, 503, 503, 503, 503, 503]);
    failing.notifier.notify(sample);
    await failing.notifier.drain();
    expect(failing.calls).toHaveLength(5);
    expect(failing.logs.join("\n")).toContain("abandoned");
  });

  it("never logs the secret, the signature, the body, or the destination path", async () => {
    const { notifier, logs, calls } = recordingNotifier([500, new Error(NOTIFY_SECRET), 200]);
    notifier.notify(sample);
    await notifier.drain();
    const text = logs.join("\n");
    const signature = (calls[0].init.headers as Record<string, string>)["x-eventforge-signature"];
    expect(text).not.toContain(NOTIFY_SECRET);
    expect(text).not.toContain(signature);
    expect(text).not.toContain("token=hidden");
    expect(text).not.toContain("sinequix/eventforge");
    expect(text).toContain("hooks.example.test");
  });

  it("validates destinations and environment configuration", () => {
    expect(validateNotifyUrl("https://example.test/hook").host).toBe("example.test");
    expect(validateNotifyUrl("http://127.0.0.1:9000/hook").port).toBe("9000");
    expect(() => validateNotifyUrl("http://example.test/hook")).toThrow("https");
    expect(() => validateNotifyUrl("https://u:p@example.test/hook")).toThrow("credentials");
    expect(() => new WebhookNotifier({ url: "https://example.test", secret: "" })).toThrow();
    expect(createNotifierFromEnv({})).toBeUndefined();
    expect(() => createNotifierFromEnv({ EVENTFORGE_NOTIFY_URL: "https://example.test" })).toThrow(
      "together",
    );
    expect(
      createNotifierFromEnv({
        EVENTFORGE_NOTIFY_URL: "https://example.test",
        EVENTFORGE_NOTIFY_SECRET: "s",
      }),
    ).toBeInstanceOf(WebhookNotifier);
  });
});
