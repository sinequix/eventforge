import { describe, expect, it } from "vitest";
import {
  classifyDestinationResponse,
  destinationMatches,
  parseChannel,
  parseChannelName,
  parseDestinationMode,
  parseDestinationStatus,
  parseDestinationUrl,
  parseEventType,
  parseFilterList,
  parseMaxRatePerSecond,
  parseRetryAfter,
  hourWindowStart,
  minuteWindowStart,
} from "../src/webhook-destinations.js";

describe("destination matching and HTTP classification", () => {
  it("matches all events when filters are empty and requires listed types/channels otherwise", () => {
    expect(
      destinationMatches({ eventTypes: [], channels: [] }, { eventType: "invoice.paid" }),
    ).toBe(true);
    expect(
      destinationMatches(
        { eventTypes: ["invoice.paid"], channels: [] },
        { eventType: "invoice.paid" },
      ),
    ).toBe(true);
    expect(
      destinationMatches(
        { eventTypes: ["invoice.paid"], channels: [] },
        { eventType: "invoice.void" },
      ),
    ).toBe(false);
    expect(
      destinationMatches(
        { eventTypes: [], channels: ["billing"] },
        { eventType: "invoice.paid", channel: "billing" },
      ),
    ).toBe(true);
    expect(
      destinationMatches({ eventTypes: [], channels: ["billing"] }, { eventType: "invoice.paid" }),
    ).toBe(false);
  });

  it("classifies destination HTTP statuses onto the existing retry/quarantine reasons", () => {
    expect(classifyDestinationResponse(200)).toBe("success");
    expect(classifyDestinationResponse(204)).toBe("success");
    expect(classifyDestinationResponse(429)).toBe("rate_limited");
    expect(classifyDestinationResponse(503)).toBe("upstream_unavailable");
    expect(classifyDestinationResponse(400)).toBe("validation_error");
    expect(classifyDestinationResponse(404)).toBe("validation_error");
    expect(classifyDestinationResponse(600)).toBe("upstream_unavailable");
    expect(classifyDestinationResponse(301)).toBe("validation_error");
    expect(classifyDestinationResponse(302)).toBe("validation_error");
  });

  it("honors Retry-After delta-seconds and HTTP dates, capped at 300s", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter("0")).toBe(1);
    expect(parseRetryAfter("900")).toBe(300);
    expect(parseRetryAfter("nope")).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:02:00 GMT", now)).toBe(120);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBeUndefined();
  });

  it("rejects private destinations and credentials in production mode", () => {
    expect(() => parseDestinationUrl("https://hooks.example.com/webhook")).not.toThrow();
    expect(() => parseDestinationUrl("https://user:pass@hooks.example.com/webhook")).toThrow(
      /credentials/,
    );
    expect(() => parseDestinationUrl("https://127.0.0.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://10.0.0.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://192.168.1.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://hooks.example.com/webhook#x")).toThrow(/fragment/);
    expect(() => parseDestinationUrl("http://example.com/hook")).toThrow(/HTTPS/);
    expect(() =>
      parseDestinationUrl("http://127.0.0.1:8787/hook", { allowHttpLoopback: true }),
    ).not.toThrow();
    expect(() => parseDestinationUrl("https://[::1]/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://169.254.1.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://172.16.0.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://100.64.0.1/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://8.8.8.8/hook")).not.toThrow();
    expect(() => parseDestinationUrl("https://example.local/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("not a url")).toThrow(/invalid/);
    expect(() => parseDestinationUrl(`https://example.com/${"a".repeat(2048)}`)).toThrow(
      /too long/,
    );
    expect(() => parseDestinationUrl("https://[::ffff:127.0.0.1]/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://[::ffff:7f00:1]/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://[::ffff:169.254.169.254]/hook")).toThrow(
      /public HTTPS/,
    );
    expect(() => parseDestinationUrl("https://[::ffff:a9fe:a9fe]/hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://localhost./hook")).toThrow(/public HTTPS/);
    expect(() => parseDestinationUrl("https://fc.com/hook")).not.toThrow();
    expect(() => parseDestinationUrl("https://fd.com/hook")).not.toThrow();
    expect(() =>
      parseDestinationUrl("http://localhost./hook", { allowHttpLoopback: true }),
    ).not.toThrow();
  });

  it("validates event types, rates, and truncates rate-limit windows", () => {
    expect(parseEventType("invoice.paid")).toBe("invoice.paid");
    expect(() => parseEventType("")).toThrow();
    expect(parseChannel(undefined)).toBeUndefined();
    expect(parseChannel("billing")).toBe("billing");
    expect(parseChannelName("billing")).toBe("billing");
    expect(() => parseChannelName("")).toThrow();
    expect(parseMaxRatePerSecond(undefined)).toBe(10);
    expect(parseMaxRatePerSecond(25)).toBe(25);
    expect(() => parseMaxRatePerSecond(0)).toThrow();
    expect(parseDestinationMode("fifo")).toBe("fifo");
    expect(parseDestinationMode(undefined)).toBe("best_effort");
    expect(() => parseDestinationMode("ordered")).toThrow();
    expect(parseDestinationStatus("paused")).toBe("paused");
    expect(parseDestinationStatus(undefined)).toBe("active");
    expect(() => parseDestinationStatus("gone")).toThrow();
    expect(parseFilterList(undefined, parseEventType)).toEqual([]);
    expect(parseFilterList(["invoice.paid", "invoice.paid"], parseEventType)).toEqual([
      "invoice.paid",
    ]);
    expect(() => parseFilterList("nope", parseEventType)).toThrow();
    expect(() =>
      parseFilterList(
        Array.from({ length: 51 }, () => "a.b"),
        parseEventType,
      ),
    ).toThrow();
    expect(() => parseChannel("no spaces allowed")).toThrow();
    expect(() => parseMaxRatePerSecond(1001)).toThrow();
    expect(
      destinationMatches(
        { eventTypes: [], channels: ["billing"] },
        { eventType: "x", channel: "ops" },
      ),
    ).toBe(false);
    expect(hourWindowStart(new Date("2026-01-01T12:34:56.000Z"))).toBe("2026-01-01T12:00:00.000Z");
    expect(minuteWindowStart(new Date("2026-01-01T12:34:56.000Z"))).toBe(
      "2026-01-01T12:34:00.000Z",
    );
  });
});
