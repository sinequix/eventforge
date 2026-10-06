import type { SafeDeliveryReason } from "./durable-delivery.js";

export const INBOUND_HOURLY_LIMIT = 1_000;
export const INBOUND_BURST_PER_MINUTE = 60;
export const PUBLISH_PAYLOAD_MAX_BYTES = 256 * 1024;
export const OUTBOUND_HTTP_TIMEOUT_MS = 55_000;
export const DESTINATION_MAX_RATE_PER_SECOND = 1_000;
export const DESTINATION_DEFAULT_RATE_PER_SECOND = 10;

export type DestinationMode = "best_effort" | "fifo";
export type DestinationStatus = "active" | "paused" | "disabled";

export type DestinationFilter = {
  eventTypes: readonly string[];
  channels: readonly string[];
};

export type PublishEvent = {
  eventType: string;
  channel?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function normalizeHostname(hostname: string): string {
  let host = unbracketHost(hostname).toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function ipv4Octets(hostname: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets;
}

function mappedIpv4(host: string): number[] | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotted) return ipv4Octets(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local"))
    return true;
  if (host.endsWith(".internal") || host === "metadata.google.internal") return true;
  const ipv4 = ipv4Octets(host) ?? mappedIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

export function parseDestinationUrl(
  value: string,
  options: { allowHttpLoopback?: boolean } = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Destination URL is invalid.");
  }
  if (parsed.username || parsed.password)
    throw new Error("Destination URL must not include credentials.");
  if (parsed.hash) throw new Error("Destination URL must not include a fragment.");
  if (value.length > 2048) throw new Error("Destination URL is too long.");
  const host = normalizeHostname(parsed.hostname);
  const loopback = isPrivateOrLoopbackHost(parsed.hostname);
  if (parsed.protocol === "https:") {
    if (loopback && !options.allowHttpLoopback)
      throw new Error("Destination URL must be a public HTTPS endpoint.");
    return parsed;
  }
  if (parsed.protocol === "http:" && options.allowHttpLoopback && LOOPBACK_HOSTS.has(host))
    return parsed;
  throw new Error("Destination URL must use HTTPS.");
}

const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function parseEventType(value: unknown): string {
  if (typeof value !== "string" || !EVENT_TYPE.test(value))
    throw new Error(
      "eventType must be 1-128 characters of letters, numbers, dot, underscore, colon, or dash.",
    );
  return value;
}

export function parseChannel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !CHANNEL.test(value))
    throw new Error(
      "channel must be 1-64 characters of letters, numbers, dot, underscore, colon, or dash.",
    );
  return value;
}

export function parseChannelName(value: unknown): string {
  const channel = parseChannel(value);
  if (!channel)
    throw new Error(
      "channel must be 1-64 characters of letters, numbers, dot, underscore, colon, or dash.",
    );
  return channel;
}

export function parseFilterList(value: unknown, parser: (entry: unknown) => string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Filters must be an array of strings.");
  if (value.length > 50) throw new Error("Filter lists are limited to 50 entries.");
  const parsed = value.map(parser);
  return [...new Set(parsed)];
}

export function destinationMatches(filter: DestinationFilter, event: PublishEvent): boolean {
  if (filter.eventTypes.length > 0 && !filter.eventTypes.includes(event.eventType)) return false;
  if (filter.channels.length > 0) {
    if (!event.channel || !filter.channels.includes(event.channel)) return false;
  }
  return true;
}

export function parseMaxRatePerSecond(value: unknown): number {
  if (value === undefined || value === null) return DESTINATION_DEFAULT_RATE_PER_SECOND;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > DESTINATION_MAX_RATE_PER_SECOND
  )
    throw new Error("maxRatePerSecond must be an integer between 1 and 1000.");
  return value;
}

export function parseDestinationMode(value: unknown): DestinationMode {
  if (value === undefined || value === null || value === "best_effort") return "best_effort";
  if (value === "fifo") return "fifo";
  throw new Error("mode must be best_effort or fifo.");
}

export function parseDestinationStatus(value: unknown): DestinationStatus {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "paused" || value === "disabled") return value;
  throw new Error("status must be active, paused, or disabled.");
}

export function classifyDestinationResponse(status: number): "success" | SafeDeliveryReason {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "validation_error";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "upstream_unavailable";
  if (status >= 400 && status < 500) return "validation_error";
  return "upstream_unavailable";
}

export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(1, Math.min(300, seconds)) : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  const seconds = Math.ceil((date - now) / 1000);
  if (seconds <= 0) return undefined;
  return Math.min(300, seconds);
}

export function hourWindowStart(now: Date): string {
  const copy = new Date(now);
  copy.setUTCMinutes(0, 0, 0);
  return copy.toISOString();
}

export function minuteWindowStart(now: Date): string {
  const copy = new Date(now);
  copy.setUTCSeconds(0, 0);
  return copy.toISOString();
}
