import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

const memoryStorage = new Map<string, string>();

function installMemoryStorage() {
  const storage: Storage = {
    get length() {
      return memoryStorage.size;
    },
    clear() {
      memoryStorage.clear();
    },
    getItem(key) {
      return memoryStorage.has(key) ? (memoryStorage.get(key) ?? null) : null;
    },
    key(index) {
      return [...memoryStorage.keys()][index] ?? null;
    },
    removeItem(key) {
      memoryStorage.delete(key);
    },
    setItem(key, value) {
      memoryStorage.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  memoryStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.querySelectorAll("script[data-eventforge-ga]").forEach((script) => script.remove());
  delete (window as AnalyticsWindow).dataLayer;
  delete (window as AnalyticsWindow).gtag;
});

describe("Google Analytics initialization", () => {
  it("queues commands using Google's supported arguments-object format", async () => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123456");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("runtime config unavailable")));
    const { initializeAnalytics } = await import("./analytics");

    await initializeAnalytics();

    const analyticsWindow = window as AnalyticsWindow;
    const script = document.querySelector<HTMLScriptElement>("script[data-eventforge-ga]");
    expect(script?.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-TEST123456");
    expect(analyticsWindow.dataLayer).toHaveLength(3);
    expect(Object.prototype.toString.call(analyticsWindow.dataLayer?.[0])).toBe(
      "[object Arguments]",
    );
    expect(Array.from(analyticsWindow.dataLayer?.[1] as ArrayLike<unknown>)).toEqual([
      "config",
      "G-TEST123456",
      expect.objectContaining({
        allow_google_signals: false,
        anonymize_ip: true,
        send_page_view: false,
      }),
    ]);
    expect(Array.from(analyticsWindow.dataLayer?.[2] as ArrayLike<unknown>)).toEqual([
      "event",
      "page_view",
      {},
    ]);
  });
});

async function loadAnalytics() {
  return import("./analytics");
}

async function capturePayload(
  event: string,
  properties?: Record<string, string | number | boolean>,
) {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  vi.stubEnv("VITE_POSTHOG_HOST", "https://us.i.posthog.com");
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const { captureEvent } = await loadAnalytics();
  captureEvent(event, properties);
  const posthogCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/capture/"));
  expect(posthogCalls).toHaveLength(1);
  return JSON.parse(String(posthogCalls[0]?.[1]?.body)) as {
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
}

describe("captureEvent attribution", () => {
  it("sends referrer, UTM params, user agent and first-touch $set_once", async () => {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://news.ycombinator.com/item?id=1",
    });
    window.history.pushState(
      {},
      "",
      "/waitlist?utm_source=hn&utm_medium=social&utm_campaign=launch",
    );
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 EventForgeTest",
    });

    const payload = await capturePayload("waitlist_submit_started", { source: "landing" });

    expect(payload.event).toBe("waitlist_submit_started");
    expect(payload.properties).toEqual(
      expect.objectContaining({
        source: "landing",
        product: "eventforge",
        $host: window.location.host,
        $current_url: window.location.href,
        $referrer: "https://news.ycombinator.com/item?id=1",
        $referring_domain: "news.ycombinator.com",
        $utm_source: "hn",
        $utm_medium: "social",
        $utm_campaign: "launch",
        $useragent: "Mozilla/5.0 EventForgeTest",
        $set_once: {
          $initial_referrer: "https://news.ycombinator.com/item?id=1",
          $initial_referring_domain: "news.ycombinator.com",
          $initial_utm_source: "hn",
          $initial_utm_medium: "social",
          $initial_utm_campaign: "launch",
        },
      }),
    );
  });

  it("uses $direct when there is no referrer and keeps first-touch across later events", async () => {
    Object.defineProperty(document, "referrer", { configurable: true, value: "" });
    window.history.pushState({}, "", "/");
    const first = await capturePayload("page_view");
    expect(first.properties.$referrer).toBe("$direct");
    expect(first.properties.$referring_domain).toBe("$direct");
    expect(first.properties.$set_once).toEqual({
      $initial_referrer: "$direct",
      $initial_referring_domain: "$direct",
    });

    vi.resetModules();
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://t.co/later",
    });
    window.history.pushState({}, "", "/waitlist?utm_source=twitter");
    const second = await capturePayload("waitlist_submit_started");
    expect(second.properties.$referrer).toBe("https://t.co/later");
    expect(second.properties.$utm_source).toBe("twitter");
    expect(second.properties.$set_once).toEqual({
      $initial_referrer: "$direct",
      $initial_referring_domain: "$direct",
    });
  });
});
