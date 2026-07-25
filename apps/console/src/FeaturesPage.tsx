import {
  ArrowLeft,
  BadgeCheck,
  BellRing,
  Boxes,
  CircleCheck,
  CircleDashed,
  Clock4,
  Coins,
  DatabaseZap,
  Fingerprint,
  GitBranch,
  Globe2,
  KeyRound,
  Landmark,
  LineChart,
  Network,
  PackageCheck,
  RotateCcw,
  Scale,
  ShieldCheck,
  SignalHigh,
  Users,
} from "lucide-react";
import { useEffect } from "react";
import { Mark } from "./Mark";
import { captureEvent } from "./analytics";

const GITHUB_REPOSITORY = "https://github.com/tebayoso/eventforge";

// Maturity is stated per feature rather than implied.
//
// Most of the 1.0-rc surface is deliberately "foundation": the contracts,
// schemas and fail-closed gates are implemented and tested, but no hosted path
// calls them yet. Labelling those "available" would be false — a gate with no
// caller protects nothing in production, and someone would build against a
// promise the product does not keep. The taxonomy is published on the page so a
// reader can calibrate instead of guessing.
type Maturity = "available" | "foundation" | "planned";

const MATURITY: Record<Maturity, { label: string; blurb: string; icon: typeof CircleCheck }> = {
  available: {
    label: "Available",
    blurb:
      "Exposed by the self-hosted control plane or the local MCP server today. The hosted cloud keeps public ingress fail-closed, so this means self-host, not managed service.",
    icon: CircleCheck,
  },
  foundation: {
    label: "Foundation",
    blurb:
      "Contracts, schemas and fail-closed gates are implemented and tested. Hosted operation is not wired yet, so the capability stays closed until it is.",
    icon: BadgeCheck,
  },
  planned: {
    label: "Planned",
    blurb: "Designed, not implemented.",
    icon: CircleDashed,
  },
};

type Feature = {
  title: string;
  text: string;
  icon: typeof CircleCheck;
  maturity: Maturity;
};

type Stage = {
  id: string;
  label: string;
  title: string;
  lead: string;
  tone: "mint" | "signal" | "violet" | "orange";
  features: Feature[];
};

const stages: Stage[] = [
  {
    id: "receive",
    label: "01 / Receive",
    title: "Verified ingress",
    lead: "Keep provider identity attached from the first byte, and refuse anything that cannot be proven.",
    tone: "mint",
    features: [
      {
        title: "Signed webhook ingress",
        text: "GitHub, Linear, Sentry and custom events with signature verification, raw payload preservation, and replay-window bounds on the timestamp.",
        icon: Fingerprint,
        maturity: "available",
      },
      {
        title: "GitHub App trust boundary",
        text: "Installation-scoped credentials with an attestation path, so an event can only act inside the installation that produced it.",
        icon: ShieldCheck,
        maturity: "available",
      },
      {
        title: "OAuth 2.1 for remote MCP",
        text: "Authorization-server metadata and protected-resource discovery for MCP clients connecting over the network rather than a local pipe.",
        icon: KeyRound,
        maturity: "available",
      },
      {
        title: "Durable delivery queue",
        text: "Per-tenant queueing with leases, bounded attempts and a dead-letter path, so a slow consumer cannot silently drop a cohort. Ships behind a disabled flag.",
        icon: PackageCheck,
        maturity: "foundation",
      },
      {
        title: "Provider installations",
        text: "Sentry and Linear installs bound to an exact installation key, so a delivery cannot cross into another workspace.",
        icon: Network,
        maturity: "available",
      },
      {
        title: "Additional demand sources",
        text: "GitLab Cloud, Jira Cloud and Datadog event matrices with closed readiness records. No provider is enabled; hosted ingress stays fail-closed until each one has its own evidence.",
        icon: Globe2,
        maturity: "foundation",
      },
    ],
  },
  {
    id: "understand",
    label: "02 / Understand",
    title: "Operational context",
    lead: "Give an operator — or an agent — the history and evidence before anyone chooses what happens next.",
    tone: "signal",
    features: [
      {
        title: "Event inbox and issue review",
        text: "One place for hooks across providers, with review state kept ahead of memory retrieval so an assessment is never built from stale context.",
        icon: DatabaseZap,
        maturity: "available",
      },
      {
        title: "Workspace and account identity",
        text: "Hosted identity with a session authority and workspace lifecycle, scoped so one tenant's evidence is never readable by another. Gated with hosted ingress.",
        icon: Users,
        maturity: "foundation",
      },
      {
        title: "Incident correlation",
        text: "Deterministic, versioned rules group related events inside a bounded window. Observe-only: it proposes memberships and never merges or suppresses on its own.",
        icon: GitBranch,
        maturity: "foundation",
      },
      {
        title: "Timeline integrity",
        text: "Content-addressed timeline entries with RFC 8785 canonical hashing, so the order and contents of a reconstruction can be verified rather than trusted.",
        icon: Clock4,
        maturity: "foundation",
      },
      {
        title: "Outcome analytics",
        text: "Outcome transitions and metric snapshots that distinguish a delivered 2xx from a verified result, with completeness bounded rather than assumed.",
        icon: LineChart,
        maturity: "foundation",
      },
      {
        title: "OpenTelemetry export",
        text: "A lifecycle schema for emitting spans and metrics to your existing collector instead of asking you to adopt another dashboard.",
        icon: SignalHigh,
        maturity: "foundation",
      },
    ],
  },
  {
    id: "decide",
    label: "03 / Decide",
    title: "Policy you can audit",
    lead: "Every decision names the policy version, the evidence, and the reason — including when it refuses.",
    tone: "violet",
    features: [
      {
        title: "Policy packs",
        text: "One deterministic evaluator emits policy and context digests, evaluator provenance, matched rules and reason codes. Packs are immutable and content-addressed; simulation runs the same evaluator as live.",
        icon: Scale,
        maturity: "foundation",
      },
      {
        title: "Graduated autonomy",
        text: "An action is only eligible with sufficient shadow evidence, a valid grant, recent MFA, budget headroom and a fresh control plane. Any non-finite or out-of-domain input denies.",
        icon: BadgeCheck,
        maturity: "foundation",
      },
      {
        title: "Enterprise governance",
        text: "Organization scopes, workspace memberships, break-glass rules and an ordered per-workspace audit stream. Scope inputs are validated before authorization, not after.",
        icon: Landmark,
        maturity: "foundation",
      },
      {
        title: "Billing entitlements",
        text: "Entitlement versions with provider-schema validation and a replay-bounded webhook path. During a provider outage the decision closes rather than trusting a cached entitlement.",
        icon: Coins,
        maturity: "foundation",
      },
    ],
  },
  {
    id: "act",
    label: "04 / Act",
    title: "Bounded automation",
    lead: "Diagnose first. Promote a write only when it is reversible, approved, budgeted and verified afterwards.",
    tone: "orange",
    features: [
      {
        title: "Reaction reservation guard",
        text: "Reservations are bounded by budget class and a two-sided kill-switch freshness check, and a malformed envelope returns a denial instead of throwing past the guard.",
        icon: BellRing,
        maturity: "foundation",
      },
      {
        title: "Connector trust",
        text: "DSSE-signed manifests bind every mutable security subject. An unparseable expiry is treated as expired, and installation stays closed while no sandbox provider is available.",
        icon: ShieldCheck,
        maturity: "foundation",
      },
      {
        title: "Connector SDK and marketplace",
        text: "Governed package manifests with publisher review, capability limits, declared data handling and digest-bound artifacts.",
        icon: Boxes,
        maturity: "foundation",
      },
      {
        title: "Notification sinks",
        text: "Operator notifications with rendering that never embeds provider actions — no mass-mention or link markup can be smuggled through a correlation id.",
        icon: BellRing,
        maturity: "foundation",
      },
    ],
  },
  {
    id: "prove",
    label: "05 / Prove",
    title: "Recovery and evidence",
    lead: "Recover a cohort deliberately, and be able to show what happened afterwards.",
    tone: "mint",
    features: [
      {
        title: "Replay with audit",
        text: "Delivery history, issue context, evidence and the approval trail stay together, with authorization and audit checked before a replay proceeds. No route exposes it yet.",
        icon: RotateCcw,
        maturity: "foundation",
      },
      {
        title: "Portable evidence export",
        text: "Content-addressed export manifests with per-artifact digests, so an exported bundle can be verified independently of the system that produced it.",
        icon: PackageCheck,
        maturity: "foundation",
      },
      {
        title: "Operational readiness",
        text: "Durable readiness evidence with server-side operator authorization and cross-tenant rejection. Future-dated evidence goes stale instead of holding a gate open.",
        icon: BadgeCheck,
        maturity: "foundation",
      },
      {
        title: "Private edge",
        text: "A Helm-rendered deployment that stays fail-closed without portable adapters, with default-deny network policy and non-root images.",
        icon: Landmark,
        maturity: "foundation",
      },
    ],
  },
];

const counts = stages
  .flatMap((stage) => stage.features)
  .reduce<Record<Maturity, number>>(
    (acc, feature) => ({ ...acc, [feature.maturity]: acc[feature.maturity] + 1 }),
    { available: 0, foundation: 0, planned: 0 },
  );

export default function FeaturesPage() {
  useEffect(() => {
    captureEvent("features_page_view");
  }, []);

  return (
    <main className="ef-landing ef-features">
      <div className="ef-grain" aria-hidden="true" />

      <header className="ef-site-header">
        <a className="ef-brand" href="/" aria-label="EventForge home">
          <Mark />
          <span>EventForge</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/#problem">Why</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#install">Install</a>
          <a href={GITHUB_REPOSITORY} rel="noreferrer noopener" target="_blank">
            GitHub
          </a>
        </nav>
      </header>

      <section className="ef-features-hero">
        <a className="ef-back-link" href="/">
          <ArrowLeft size={14} /> Back to overview
        </a>
        <span className="ef-section-label">Capabilities</span>
        <h1>
          Every hook, from receipt
          <br />
          to <em>verified outcome.</em>
        </h1>
        <p className="ef-features-lead">
          EventForge is built safety-rails first. The contracts and gates below are implemented and
          tested before the automation that will use them, which means a lot of this surface is
          deliberately closed rather than quietly half-working.
        </p>

        <dl className="ef-maturity-key" aria-label="How to read the status on each capability">
          {(Object.keys(MATURITY) as Maturity[])
            .filter((key) => counts[key] > 0)
            .map((key) => {
              const { label, blurb, icon: Icon } = MATURITY[key];
              return (
                <div className={`ef-maturity-key-item ef-maturity--${key}`} key={key}>
                  <dt>
                    <Icon size={14} /> {label}
                    <span className="ef-maturity-count">{counts[key]}</span>
                  </dt>
                  <dd>{blurb}</dd>
                </div>
              );
            })}
        </dl>
      </section>

      {stages.map(({ id, label, title, lead, tone, features }) => (
        <section className={`ef-feature-stage ef-feature-stage--${tone}`} id={id} key={id}>
          <div className="ef-feature-stage-head">
            <span className="ef-section-label">{label}</span>
            <h2>{title}</h2>
            <p>{lead}</p>
          </div>
          <div className="ef-feature-grid">
            {features.map(({ title: name, text, icon: Icon, maturity }) => {
              const { label: statusLabel, icon: StatusIcon } = MATURITY[maturity];
              return (
                <article className={`ef-feature ef-feature--${tone}`} key={name}>
                  <div className="ef-feature-topline">
                    <Icon size={18} />
                    <span className={`ef-feature-status ef-maturity--${maturity}`}>
                      <StatusIcon size={12} /> {statusLabel}
                    </span>
                  </div>
                  <h3>{name}</h3>
                  <p>{text}</p>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      <section className="ef-features-close">
        <h2>
          Read the code before
          <br />
          <em>you trust the claim.</em>
        </h2>
        <p>
          Every capability above ships with tests that assert the closed path, not just the happy
          one. The status labels are meant to be checkable against the repository.
        </p>
        <div className="ef-features-actions">
          <a
            className="ef-primary-cta"
            href={GITHUB_REPOSITORY}
            rel="noreferrer noopener"
            target="_blank"
          >
            Browse the source
          </a>
          <a className="ef-close-link" href="/#install">
            Install the MCP server <span className="ef-close-arrow">→</span>
          </a>
        </div>
      </section>

      <footer className="ef-footer">
        <span>EventForge · every hook, from receipt to verified outcome</span>
        <div className="ef-footer-links">
          <a href="/">Overview</a>
          <a href="/#pricing">Pricing</a>
          <a href={GITHUB_REPOSITORY} rel="noreferrer noopener" target="_blank">
            GitHub
          </a>
        </div>
      </footer>
    </main>
  );
}
