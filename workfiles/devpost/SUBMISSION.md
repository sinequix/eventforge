# EventForge — Devpost submission packet

## Project title and tagline

**EventForge**

_Turn webhook noise into safe, agent-ready engineering work._

## Project URL and demo

- **Repository:** [github.com/sinequix/eventforge](https://github.com/sinequix/eventforge)
- **Demo video:** [youtu.be/pht3rrl--pE](https://youtu.be/pht3rrl--pE)

## Description

EventForge is a policy-first operations layer for engineering events. It ingests GitHub, Linear, Sentry, and custom signals; normalizes and audits them; gives a read-only Codex investigation process-scoped project memory; and turns any consequential next step into an explicit approval decision.

The result is a calmer engineering loop: an agent can investigate a failed CI run or a newly opened issue immediately, while people retain control over pull requests, provider writes, and generated connectors.

## Project story

Codex is extraordinarily capable once an engineering task is in front of it, but teams still spend time watching CI, triaging alerts, and moving context between GitHub, Linear, and Sentry. EventForge closes that gap with an event layer built for Codex.

An incoming provider delivery is treated as untrusted evidence. EventForge verifies its signature, redacts sensitive fields, deduplicates it for the current local process, matches it against a scoped workflow, and starts a read-only Codex investigation. The resulting summary and process-scoped memory are visible in the operations console. If a next step needs a write, the platform creates a reviewable proposal instead of silently performing the action.

Forge Studio extends that same model to integrations. A request produces generated draft source files, requested capabilities, and scanner findings. The console requires a reviewer to inspect every draft file before it can be approved; approval records the decision but never hot-loads or executes generated code.

Codex, using GPT-5.6, helped turn this product design into the TypeScript monorepo, Codex plugin/MCP server, event workflows, policy gates, process-lifetime resumable reviews, operations console, and verification loop. At runtime, EventForge uses the Codex SDK to create read-only review threads that make the demo feel proactive rather than reactive.

## Built with

Copy these implemented-technology tags into Devpost (22 total):

```text
Codex
GPT-5.6
MCP
Model Context Protocol
Event Hooks
Automations
Agentic Workflows
Developer Tools
Plugin
MCP Server
Dynamic Forging
Electron
Node.js
TypeScript
React
Tailwind
GitHub Integration
Linear Integration
Observability
Safety Approvals
Sub-Agents
OpenAI Build Week
```

## Installation and test method

### Demo mode

Prerequisites are Node.js 22.17+, Corepack, and pnpm 11.5.1.

In the first terminal:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm quality
pnpm dev
```

In a second terminal:

```bash
pnpm dev:console
```

Open `http://localhost:5173`, select **Run GitHub CI demo**, inspect the generated approval proposal, then open **Forge Studio** and select **Review artifact** before approving or rejecting the connector draft.

### Signed GitHub issue review

This optional live flow additionally requires authenticated `gh` and Codex CLIs, `cloudflared`, and repository webhook-administration permission. In the first terminal:

```bash
pnpm dev:github
```

In a second terminal:

```bash
pnpm dev:console
```

Then create the issue:

```bash
gh issue create --repo sinequix/eventforge \
  --title "Review this engineering issue" \
  --body "Describe the problem, expected behavior, and relevant context."
```

EventForge acknowledges the webhook immediately, runs a read-only Codex review whose thread ID is retained for the current process, and leaves `/actions` empty for this issue-only workflow. Verify it with:

```bash
curl http://127.0.0.1:4310/runs
curl http://127.0.0.1:4310/actions
```

## Final submission checklist

- [x] Project title and tagline
- [x] Project description and story
- [x] Built-with tags
- [x] Demo video
- [x] Public repository URL
- [x] Installation instructions and test method
- [ ] Paste the real Codex `/feedback` session ID into the Devpost form
- [ ] Create or update the Devpost draft and confirm the published preview
