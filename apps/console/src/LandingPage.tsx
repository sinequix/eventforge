import { useEffect, useState } from "react";
import { Mark } from "./Mark";
import {
  ArrowUpRight,
  Asterisk,
  BellRing,
  Braces,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDotDashed,
  CornerDownRight,
  DatabaseZap,
  FileCheck2,
  Fingerprint,
  Flame,
  Github,
  Gauge,
  GitPullRequest,
  Globe2,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Waves,
  Workflow,
} from "lucide-react";

const GITHUB_REPOSITORY = "https://github.com/tebayoso/eventforge";
const CONFIGURATION_GUIDE = `${GITHUB_REPOSITORY}/blob/main/workfiles/CONFIGURATION.md`;
const GITHUB_API = "https://api.github.com/repos/tebayoso/eventforge";

const capabilities = [
  {
    label: "01 / Receive",
    title: "Verified ingress",
    text: "Accept signed GitHub, Linear, Sentry, and custom events, preserve the raw payload, and keep provider identity attached from the first byte.",
    icon: Fingerprint,
    tone: "mint",
    status: "Available now",
  },
  {
    label: "02 / Understand",
    title: "Operational context",
    text: "Trace an event through policy, memory, agent investigation, approval, and audit so operators see what happened before choosing what happens next.",
    icon: DatabaseZap,
    tone: "signal",
    status: "Available now",
  },
  {
    label: "03 / Recover",
    title: "Replay without guesswork",
    text: "Keep delivery history, issue context, evidence, and the approval trail together. Recover a cohort deliberately instead of clicking retry until it works.",
    icon: RotateCcw,
    tone: "violet",
    status: "Foundation shipped",
  },
  {
    label: "04 / React",
    title: "Bounded automation",
    text: "Let diagnostic agents investigate first. Promote reversible reactions only through versioned policy, explicit approval, budgets, and post-action verification.",
    icon: ShieldCheck,
    tone: "orange",
    status: "Foundation shipped",
  },
];

const pricingPlans = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    description: "A complete low-volume reliability loop for developers.",
    volume: "25,000 routed deliveries / month",
    features: [
      "1 seat · 1 production project + dev",
      "3 routes · 3-day payloads",
      "30-day metadata · 1 alert destination",
      "Manual replay · CLI/MCP read",
    ],
  },
  {
    name: "Team",
    price: "$39",
    cadence: "/ month",
    description: "Shared operations for a growing engineering team.",
    volume: "250,000 routed deliveries / month",
    features: [
      "5 seats · unlimited routes",
      "14-day payloads · 90-day metadata",
      "Transforms and issue grouping",
      "Batch replay · 5 alert destinations",
    ],
  },
  {
    name: "Pro",
    price: "$149",
    cadence: "/ month",
    description: "Outcome-aware operations for production systems.",
    volume: "2 million routed deliveries / month",
    features: [
      "15 seats · SLOs and burn-rate policies",
      "30-day payload retention",
      "Schema drift · OpenTelemetry export",
      "Diagnostics · 1,000 reaction runs",
    ],
    featured: true,
  },
  {
    name: "Business",
    price: "$499",
    cadence: "/ month",
    description: "Governance, approvals, and private execution.",
    volume: "10 million routed deliveries / month",
    features: [
      "RBAC · approval workflows · audit export",
      "Private agents · static egress",
      "90-day metadata retention",
      "Support SLA and operating guardrails",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "annual",
    description: "Regional, private, and compliance-ready operations.",
    volume: "Contracted delivery bands",
    features: [
      "BYO storage and KMS",
      "Residency · private networking · private edge",
      "Custom retention and audit export",
      "SLA, support, and usage entitlement APIs",
    ],
  },
];

const roadmap = [
  {
    stage: "Gateway",
    title: "Every hook, in and out",
    text: "Signing, rotation, routing, transforms, fan-out, retries, rate limits, circuit breakers, DLQs, and outbound SDKs in one control plane.",
    icon: Globe2,
  },
  {
    stage: "Operations",
    title: "Know when a 2xx still failed",
    text: "Semantic outcome verification, issue grouping, SLOs, anomaly detection, alert compression, blast-radius views, and portable evidence bundles.",
    icon: Gauge,
  },
  {
    stage: "Reactions",
    title: "Act carefully, with proof",
    text: "Read-only diagnosis first; then approval-gated, reversible runbooks with idempotency keys, caps, rollback instructions, and verification.",
    icon: BellRing,
  },
];

function useGitHubStats() {
  const [stats, setStats] = useState<{ stars: number | null; forks: number | null }>({
    stars: null,
    forks: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch(GITHUB_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { stargazers_count?: number; forks_count?: number } | undefined) => {
        if (data) {
          setStats({ stars: data.stargazers_count ?? 0, forks: data.forks_count ?? 0 });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return stats;
}

function GitHubLink({ compact = false }: { compact?: boolean }) {
  const { stars, forks } = useGitHubStats();
  return (
    <a
      className={compact ? "ef-github-link ef-github-link--compact" : "ef-github-link"}
      href={GITHUB_REPOSITORY}
      target="_blank"
      rel="noreferrer"
    >
      <Github size={compact ? 15 : 17} />
      <span>GitHub</span>
      <span className="ef-github-stat">
        <Star size={12} fill="currentColor" /> {stars === null ? "—" : stars.toLocaleString()}
      </span>
      {!compact && (
        <span className="ef-github-forks">
          {forks === null ? "—" : forks.toLocaleString()} forks
        </span>
      )}
    </a>
  );
}

const principles = [
  {
    marker: "01",
    title: "One event inbox",
    text: "Bring GitHub, Linear, Sentry, and custom webhooks into one place instead of asking your team to keep five tabs open.",
    icon: Waves,
  },
  {
    marker: "02",
    title: "Less noise, more signal",
    text: "Use policies to surface the events that need attention and keep the routine chatter out of your team’s way.",
    icon: CircleDotDashed,
  },
  {
    marker: "03",
    title: "Agents start with context",
    text: "When something matters, an agent can investigate and prepare the next step — so people start with an answer, not a blank page.",
    icon: LockKeyhole,
  },
];

function TraceBoard() {
  return (
    <div className="ef-trace-board" aria-label="A sample EventForge event inbox">
      <div className="ef-trace-header">
        <span>One event inbox</span>
        <span>What deserves attention</span>
      </div>
      <svg className="ef-trace-wire" viewBox="0 0 500 430" aria-hidden="true">
        <path d="M55 72 C160 72, 142 178, 252 178 S328 278, 438 278" />
        <path className="ef-trace-dash" d="M55 72 C160 72, 142 178, 252 178 S328 278, 438 278" />
        <circle cx="55" cy="72" r="7" />
        <circle cx="252" cy="178" r="7" />
        <circle cx="438" cy="278" r="7" />
      </svg>
      <article className="ef-trace-card ef-trace-card--signal">
        <span className="ef-card-kicker">
          <Waves size={13} /> Event received
        </span>
        <strong>CI failed on main</strong>
        <p>GitHub · verified · high impact</p>
      </article>
      <article className="ef-trace-card ef-trace-card--read">
        <span className="ef-card-kicker">
          <Sparkles size={13} /> Worth a closer look
        </span>
        <strong>Context gathered</strong>
        <p>What changed · what failed · what to do next</p>
      </article>
      <article className="ef-trace-card ef-trace-card--decision">
        <span className="ef-card-kicker">
          <ShieldCheck size={13} /> Ready for your team
        </span>
        <strong>A clear next step</strong>
        <p>Review only when a decision is needed</p>
        <span className="ef-review-stamp">USEFUL</span>
      </article>
      <span className="ef-trace-caption">The events matter. The rest can stay quiet.</span>
    </div>
  );
}

function DecisionLedger() {
  return (
    <div className="ef-ledger" aria-label="EventForge value summary">
      <div className="ef-ledger-topline">
        <span>What EventForge gives you</span>
        <span>One useful view</span>
      </div>
      <div className="ef-ledger-row">
        <span className="ef-ledger-index">A</span>
        <span>Sources</span>
        <strong>GitHub, Linear, Sentry, custom</strong>
        <Check size={16} />
      </div>
      <div className="ef-ledger-row">
        <span className="ef-ledger-index">B</span>
        <span>Priority</span>
        <strong>Only events that match your rules</strong>
        <Check size={16} />
      </div>
      <div className="ef-ledger-row">
        <span className="ef-ledger-index">C</span>
        <span>Context</span>
        <strong>What happened and what changed</strong>
        <Check size={16} />
      </div>
      <div className="ef-ledger-row ef-ledger-row--verdict">
        <span className="ef-ledger-index">D</span>
        <span>Outcome</span>
        <strong>A next step your team can use</strong>
        <span className="ef-pulse" />
      </div>
      <div className="ef-ledger-foot">
        <Fingerprint size={17} /> Start with the signal, not the alert fatigue.
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="ef-landing">
      <div className="ef-grain" aria-hidden="true" />
      <header className="ef-site-header">
        <a className="ef-brand" href="/" aria-label="EventForge home">
          <Mark />
          <span>EventForge</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="/features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href={CONFIGURATION_GUIDE} target="_blank" rel="noreferrer">
            Docs
          </a>
          <GitHubLink compact />
          <a className="ef-nav-console" href="/console">
            Open console <ArrowUpRight size={15} />
          </a>
        </nav>
      </header>

      <section className="ef-hero">
        <div className="ef-hero-copy">
          <div className="ef-eyebrow">
            <Asterisk size={14} /> The operational control plane for every hook
          </div>
          <h1>
            Every hook.
            <br />
            One control plane.
            <br />
            <em>Verified outcomes.</em>
          </h1>
          <p className="ef-hero-intro">
            Ingest, route, observe, replay, and safely react to webhook-driven work from receipt to
            outcome. EventForge gives developer and platform teams one place to see what happened,
            why it matters, and what is safe to do next.
          </p>
          <div className="ef-hero-actions">
            <a className="ef-primary-cta" href="#install">
              Install with Codex <Terminal size={17} />
            </a>
            <a className="ef-secondary-cta" href="/console">
              Open the console <ArrowUpRight size={16} />
            </a>
            <a
              className="ef-text-cta"
              href="https://youtu.be/pht3rrl--pE"
              target="_blank"
              rel="noreferrer"
            >
              <Play size={15} fill="currentColor" /> Watch the demo
            </a>
          </div>
          <div className="ef-hero-footnote">
            <span className="ef-live-dot" /> Free local demo · 9 MCP tools · GitHub, Linear, Sentry,
            and custom events
          </div>
        </div>
        <TraceBoard />
      </section>

      <section className="ef-proof-strip" aria-label="EventForge product facts">
        <div>
          <strong>9</strong>
          <span>stable MCP tools</span>
        </div>
        <div>
          <strong>4</strong>
          <span>event source types</span>
        </div>
        <div>
          <strong>0</strong>
          <span>credentials for local demo</span>
        </div>
        <div>
          <strong>1</strong>
          <span>audit trail from event to decision</span>
        </div>
        <GitHubLink />
      </section>

      <section className="ef-manifesto" id="problem">
        <div className="ef-section-label">
          <span>The problem</span>
          <span>Your tools are busy. Your team should not be.</span>
        </div>
        <div className="ef-manifesto-copy">
          <p className="ef-manifesto-lead">
            Your tools are talking.
            <br />
            <i>EventForge helps you hear the right things.</i>
          </p>
          <p>
            GitHub alerts, Linear updates, Sentry issues, and custom webhooks create a constant
            stream of activity. EventForge collects that stream, applies your rules, and gives your
            team a calmer queue of events that are actually worth acting on.
          </p>
        </div>
        <div className="ef-side-annotation">
          <CornerDownRight size={18} />
          <span>
            One overlay
            <br />
            for every signal.
          </span>
        </div>
      </section>

      <section className="ef-principles" id="principles">
        <div className="ef-section-heading">
          <span className="ef-section-label">The value</span>
          <h2>
            More clarity around
            <br />
            the work that matters.
          </h2>
        </div>
        <div className="ef-principle-grid">
          {principles.map(({ marker, title, text, icon: Icon }) => (
            <article className="ef-principle" key={marker}>
              <div className="ef-principle-head">
                <span>{marker}</span>
                <Icon size={20} />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ef-capabilities" id="product">
        <div className="ef-capabilities-heading">
          <div>
            <span className="ef-section-label">The control plane</span>
            <h2>
              From receipt to
              <br />
              <em>verified outcome.</em>
            </h2>
          </div>
          <p>
            Keep the fast path deterministic. Put context, decisions, and bounded automation around
            it.
          </p>
        </div>
        <div className="ef-capability-grid">
          {capabilities.map(({ label, title, text, icon: Icon, tone, status }) => (
            <article className={`ef-capability ef-capability--${tone}`} key={label}>
              <div className="ef-capability-topline">
                <span>{label}</span>
                <Icon size={18} />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className="ef-capability-status">
                <CircleCheck size={14} /> {status}
              </span>
            </article>
          ))}
        </div>
        <p className="ef-capabilities-note">
          &ldquo;Foundation shipped&rdquo; means the contracts and fail-closed gates are implemented
          and tested, but no hosted path calls them yet.{" "}
          <a href="/features">See all 24 capabilities and their status →</a>
        </p>
        <div className="ef-surface-row">
          <span>Equal operating surfaces</span>
          <strong>API</strong>
          <strong>CLI</strong>
          <strong>MCP</strong>
          <strong>OpenTelemetry</strong>
          <strong>Console</strong>
        </div>
      </section>

      <section className="ef-roadmap" id="roadmap">
        <div className="ef-roadmap-intro">
          <span className="ef-eyebrow">
            <Sparkles size={14} /> The roadmap
          </span>
          <h2>
            Start with delivery.
            <br />
            <em>Earn autonomy.</em>
          </h2>
          <p>
            EventForge integrates with durable runtimes instead of replacing them. The control plane
            grows in three deliberate layers.
          </p>
        </div>
        <div className="ef-roadmap-list">
          {roadmap.map(({ stage, title, text, icon: Icon }, index) => (
            <article className="ef-roadmap-item" key={stage}>
              <span className="ef-roadmap-index">0{index + 1}</span>
              <Icon size={21} />
              <div>
                <span>{stage}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="ef-pricing" id="pricing">
        <div className="ef-pricing-heading">
          <div>
            <span className="ef-section-label">Land and expand</span>
            <h2>
              Free to prove.
              <br />
              <em>Priced to grow.</em>
            </h2>
          </div>
          <p>
            Retries, filtering, monitoring, alerts, and manual diagnosis stay free. Pay as your team
            adds retention, collaboration, governance, private execution, and bounded reactions.
          </p>
        </div>
        <div className="ef-pricing-grid">
          {pricingPlans.map(({ name, price, cadence, description, volume, features, featured }) => (
            <article
              className={`ef-price-card${featured ? " ef-price-card--featured" : ""}`}
              key={name}
            >
              {featured && <span className="ef-price-badge">Most teams start here</span>}
              <div className="ef-price-card-head">
                <h3>{name}</h3>
                <span>{volume}</span>
              </div>
              <div className="ef-price">
                <strong>{price}</strong>
                <span>{cadence}</span>
              </div>
              <p>{description}</p>
              <ul>
                {features.map((feature) => (
                  <li key={feature}>
                    <Check size={15} /> {feature}
                  </li>
                ))}
              </ul>
              <a
                href="#install"
                className={featured ? "ef-price-cta ef-price-cta--active" : "ef-price-cta"}
              >
                {name === "Enterprise"
                  ? "Talk to EventForge"
                  : name === "Free"
                    ? "Start free"
                    : "Join the beta"}
                <ArrowUpRight size={15} />
              </a>
            </article>
          ))}
        </div>
        <div className="ef-pricing-note">
          <Braces size={16} /> One billable unit is the first external attempt for an
          event-destination pair. Retries, filters, alerts, and failed internal processing are free.
          Team overage starts at $0.50 / 100k; Pro at $0.30 / 100k. Preview packaging; final prices
          are validated with design partners before public billing.
        </div>
      </section>

      <section className="ef-install" id="install">
        <div className="ef-install-copy">
          <span className="ef-eyebrow">
            <Terminal size={14} /> Start in one command
          </span>
          <h2>
            Your first useful event
            <br />
            <em>is five minutes away.</em>
          </h2>
          <p>
            EventForge starts locally with no account, no password, and no cloud setup. Connect a
            remote OAuth host later without changing the operating surface.
          </p>
          <div className="ef-install-links">
            <a href={CONFIGURATION_GUIDE} target="_blank" rel="noreferrer">
              Read configuration docs <ArrowUpRight size={15} />
            </a>
            <GitHubLink compact />
          </div>
        </div>
        <div className="ef-code-card">
          <div className="ef-code-header">
            <span>
              <span className="ef-code-dot" /> Codex MCP
            </span>
            <span>local / passwordless</span>
          </div>
          <pre>
            <code>
              {
                'codex mcp add eventforge\n  --env EVENTFORGE_CODEX_WORKDIR="$PWD"\n  -- npx -y --package\n  github:tebayoso/eventforge eventforge-mcp'
              }
            </code>
          </pre>
          <div className="ef-code-footer">
            <CircleCheck size={15} /> Starts a loopback control plane at 127.0.0.1:4310
          </div>
        </div>
      </section>

      <section className="ef-proof">
        <div className="ef-proof-copy">
          <div className="ef-eyebrow">
            <Flame size={14} /> An overlay, not another replacement
          </div>
          <h2>
            Keep your stack.
            <br />
            Make it <em>quieter.</em>
          </h2>
          <p>
            EventForge sits above the tools and automations you already run. It gives their events a
            shared inbox, a common set of rules, and agents that can take the first pass when
            something deserves attention.
          </p>
          <ul>
            <li>
              <GitPullRequest size={17} /> Stop chasing alerts across every tool.
            </li>
            <li>
              <FileCheck2 size={17} /> See the context behind an event before you act.
            </li>
            <li>
              <Workflow size={17} /> Let agents help with the follow-up, not the noise.
            </li>
          </ul>
        </div>
        <DecisionLedger />
      </section>

      <section className="ef-close">
        <div className="ef-close-meta">
          <span>EventForge</span>
          <span>Bring your event stream under one roof.</span>
        </div>
        <h2>
          Turn webhook noise
          <br />
          into <em>useful work.</em>
        </h2>
        <a className="ef-close-link" href="/console">
          Open your event inbox <ArrowUpRight size={23} />
        </a>
        <ChevronDown className="ef-close-arrow" size={23} aria-hidden="true" />
      </section>

      <footer className="ef-footer">
        <a className="ef-brand" href="/">
          <Mark />
          <span>EventForge</span>
        </a>
        <span>Policy-first operations for event-driven teams.</span>
        <div className="ef-footer-links">
          <a href={CONFIGURATION_GUIDE} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href={GITHUB_REPOSITORY} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <span>© 2026</span>
        </div>
      </footer>
    </main>
  );
}
