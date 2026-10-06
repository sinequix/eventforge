// Public surface of @eventforge/core.
//
// Two tiers, deliberately:
//
// 1. FLAT re-exports — the established core that consumers already import by
//    bare name (apps/control-plane, apps/cloudflare, packages/mcp-server).
//    Kept flat for backwards compatibility.
//
// 2. NAMESPACED re-exports — feature modules. `export *` across many modules
//    collapses every symbol into one flat namespace, so each new module raised
//    the chance of a silent name clash. Integrating the 1.0-rc branches produced
//    five such clashes (canonicalManifest, manifestDigest, ConnectorManifest,
//    canonicalJson, Approval) — each surfaced only once two branches were merged
//    together, so no single branch's CI could see them. Namespacing bounds each
//    module's names to its own object, so adding a module can no longer collide
//    with an existing one.
//
// A namespaced module may graduate to tier 1 when it gains real consumers, but
// only after checking its names against the flat surface.

export * from "./contracts.js";
export * from "./durable-delivery.js";
export * from "./events.js";
export * from "./forge.js";
export * from "./issue-review.js";
export * from "./store.js";
export * from "./workflows.js";

export * as autonomy from "./autonomy.js";
export * as billing from "./billing.js";
export * as connectorTrust from "./connector-trust.js";
export * as demandSources from "./demand-sources.js";
export * as memory from "./memory.js";
export * as notifications from "./notifications.js";
export * as outcomes from "./outcomes.js";
export * as platform from "./platform.js";
export * as policyPacks from "./policy-packs.js";
export * as providerInstallations from "./provider-installations.js";
export * as reactionWorker from "./reaction-worker.js";
export * as replayAudit from "./replay-audit.js";
export * as sdk from "./sdk.js";
export * as standardWebhooks from "./standard-webhooks.js";
export * as telemetry from "./telemetry.js";
export * as timeline from "./timeline.js";
export * as webhookDestinations from "./webhook-destinations.js";
