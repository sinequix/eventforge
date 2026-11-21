type AnalyticsProperties = Record<string, string | number | boolean | undefined>;
type PublicAnalyticsConfig = {
  posthogKey?: string;
  posthogHost?: string;
  gaMeasurementId?: string;
};

type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

const fallbackConfig: Required<PublicAnalyticsConfig> = {
  posthogKey: import.meta.env.VITE_POSTHOG_KEY?.trim() || "",
  posthogHost: (import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(
    /\/$/,
    "",
  ),
  gaMeasurementId: import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() || "",
};
let analyticsConfig = fallbackConfig;

let anonymousId: string | undefined;

const ANONYMOUS_ID_KEY = "eventforge-anonymous-id";
const FIRST_TOUCH_KEY = "eventforge-first-touch";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const DIRECT = "$direct";

type FirstTouchProperties = {
  $initial_referrer?: string;
  $initial_referring_domain?: string;
  $initial_utm_source?: string;
  $initial_utm_medium?: string;
  $initial_utm_campaign?: string;
  $initial_utm_term?: string;
  $initial_utm_content?: string;
};

function getAnonymousId(): string {
  if (anonymousId) return anonymousId;
  try {
    anonymousId = window.localStorage.getItem(ANONYMOUS_ID_KEY) ?? crypto.randomUUID();
    window.localStorage.setItem(ANONYMOUS_ID_KEY, anonymousId);
  } catch {
    anonymousId = crypto.randomUUID();
  }
  return anonymousId;
}

function referringDomain(referrer: string): string | undefined {
  try {
    return new URL(referrer).hostname || undefined;
  } catch {
    return undefined;
  }
}

function utmFromSearch(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim();
    if (value) utm[`$${key}`] = value;
  }
  return utm;
}

function readStoredFirstTouch(): FirstTouchProperties | undefined {
  try {
    const raw = window.localStorage.getItem(FIRST_TOUCH_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const stored: FirstTouchProperties = {};
    const record = parsed as Record<string, unknown>;
    const keys: (keyof FirstTouchProperties)[] = [
      "$initial_referrer",
      "$initial_referring_domain",
      "$initial_utm_source",
      "$initial_utm_medium",
      "$initial_utm_campaign",
      "$initial_utm_term",
      "$initial_utm_content",
    ];
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value) stored[key] = value;
    }
    return Object.keys(stored).length > 0 ? stored : undefined;
  } catch {
    return undefined;
  }
}

function firstTouchProperties(
  referrer: string,
  domain: string,
  utm: Record<string, string>,
): FirstTouchProperties {
  const stored = readStoredFirstTouch();
  if (stored) return stored;
  const next: FirstTouchProperties = {
    $initial_referrer: referrer,
    $initial_referring_domain: domain,
  };
  for (const key of UTM_KEYS) {
    const value = utm[`$${key}`];
    if (value) next[`$initial_${key}`] = value;
  }
  try {
    window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(next));
  } catch {
    // First-touch still goes on this event even if it cannot be persisted.
  }
  return next;
}

function attributionProperties(): Record<string, unknown> {
  const referrer = document.referrer.trim() || DIRECT;
  const domain = referrer === DIRECT ? DIRECT : (referringDomain(referrer) ?? DIRECT);
  const utm = utmFromSearch(window.location.search);
  return {
    $current_url: window.location.href,
    $host: window.location.host,
    product: "eventforge",
    $referrer: referrer,
    $referring_domain: domain,
    $useragent: navigator.userAgent,
    ...utm,
    $set_once: firstTouchProperties(referrer, domain, utm),
  };
}

function initializeGoogleAnalytics(): void {
  if (!analyticsConfig.gaMeasurementId || document.querySelector("script[data-eventforge-ga]"))
    return;
  const analyticsWindow = window as AnalyticsWindow;
  analyticsWindow.dataLayer = analyticsWindow.dataLayer || [];
  analyticsWindow.gtag = function gtag() {
    // gtag.js requires its commands to be queued as the function's arguments object.
    // eslint-disable-next-line prefer-rest-params
    analyticsWindow.dataLayer?.push(arguments);
  };
  analyticsWindow.gtag("js", new Date());
  analyticsWindow.gtag("config", analyticsConfig.gaMeasurementId, {
    anonymize_ip: true,
    allow_google_signals: false,
    page_title: document.title,
    send_page_view: false,
  });
  const script = document.createElement("script");
  script.async = true;
  script.dataset.eventforgeGa = "true";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsConfig.gaMeasurementId)}`;
  document.head.append(script);
}

export function captureEvent(event: string, properties: AnalyticsProperties = {}): void {
  const payload = {
    api_key: analyticsConfig.posthogKey,
    event,
    distinct_id: getAnonymousId(),
    properties: {
      ...properties,
      ...attributionProperties(),
    },
  };
  if (analyticsConfig.posthogKey) {
    void fetch(`${analyticsConfig.posthogHost}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  }

  const analyticsWindow = window as AnalyticsWindow;
  analyticsWindow.gtag?.("event", event, properties);
}

export function initializeAnalytics(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return fetch("/analytics-config.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((config: PublicAnalyticsConfig | undefined) => {
      if (config) {
        analyticsConfig = {
          posthogKey: config.posthogKey?.trim() || fallbackConfig.posthogKey,
          posthogHost: (config.posthogHost?.trim() || fallbackConfig.posthogHost).replace(
            /\/$/,
            "",
          ),
          gaMeasurementId: config.gaMeasurementId?.trim() || fallbackConfig.gaMeasurementId,
        };
      }
    })
    .catch(() => undefined)
    .finally(() => {
      initializeGoogleAnalytics();
      captureEvent("page_view");
    });
}
