import { describe, expect, it } from "vitest";

// The barrel's two-tier contract (see src/index.ts) is what stops feature modules
// from colliding in one flat namespace. Integrating the 1.0-rc branches produced
// five such collisions, each invisible until two branches were merged together.
// These tests fail if someone flattens a namespaced module back into the top
// level, which would reopen that failure mode.

const NAMESPACED = [
  "autonomy",
  "billing",
  "connectorTrust",
  "demandSources",
  "memory",
  "notifications",
  "outcomes",
  "platform",
  "policyPacks",
  "providerInstallations",
  "reactionWorker",
  "replayAudit",
  "sdk",
  "standardWebhooks",
  "telemetry",
  "timeline",
  "webhookDestinations",
] as const;

// Consumers (apps/control-plane, apps/cloudflare, packages/mcp-server) import
// these by bare name, so they must stay flat.
const FLAT_SENTINELS = [
  "EventEnvelopeSchema",
  "EventForgeStore",
  "AgentRunSchema",
  "ForgeJobSchema",
  "IssueReviewAssessmentSchema",
] as const;

describe("core barrel contract", () => {
  it("imports without throwing so suites that reach it still collect tests", async () => {
    await expect(import("../src/index.js")).resolves.toBeDefined();
  });

  it("exposes every feature module as its own namespace", async () => {
    const barrel = await import("../src/index.js");
    for (const name of NAMESPACED) {
      const ns = (barrel as unknown as Record<string, unknown>)[name];
      expect(ns, `${name} must be exported as a namespace`).toBeTypeOf("object");
      expect(Object.keys(ns as object).length, `${name} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("keeps the established core flat for existing consumers", async () => {
    const barrel = (await import("../src/index.js")) as unknown as Record<string, unknown>;
    for (const name of FLAT_SENTINELS) {
      expect(barrel[name], `${name} must stay flat`).toBeDefined();
    }
  });

  it("keeps namespaced modules out of the flat surface", async () => {
    const barrel = (await import("../src/index.js")) as unknown as Record<string, unknown>;
    // Names that previously collided across modules. Each must now be reachable
    // only through its own namespace, never at the top level.
    for (const name of [
      "manifestDigest",
      "canonicalJson",
      "canonicalRfc8785Json",
      "policyPackManifestDigest",
      "ConnectorPackageManifestSchema",
    ]) {
      expect(barrel[name], `${name} must not be re-flattened onto the barrel`).toBeUndefined();
    }
  });
});
