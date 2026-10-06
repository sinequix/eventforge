# EventForge browser playbook

## 2026-07-17 — Operations console acceptance flow

- Started the control plane with `EVENTFORGE_DEMO_MODE=true pnpm --filter @eventforge/control-plane start` and the console with `pnpm --filter @eventforge/console dev`.
- Opened `http://localhost:5173` in the `eventforge-qa` agent-browser session and verified the command center, connector health, empty approval state, and Forge Studio rendered correctly.
- Selected **Run GitHub CI demo**. Outcome: a normalized `github:check_run` demo event appeared, the CI-investigator run was created, private project memory was written, and a pending PR proposal surfaced.
- Opened the proposal and selected **Approve action**. Outcome: the dialog closed, the approval queue cleared, and the audit timeline recorded the reviewer decision; no automatic provider write occurred.
- Selected **Forge draft**, then **Approve artifact**. Outcome: the generated Linear/GitHub connector showed its requested scopes and reached `approved`; the UI explicitly states installation remains a separate local action.
- Selected **Linear event** and **Sentry alert**. Outcome: both normalized demo events appeared in the live feed; no unmatched workflow created a write proposal.
- Screenshots captured during the run: `/tmp/eventforge-console.png`, `/tmp/eventforge-approved.png`, and `/tmp/eventforge-forge-approved.png`.

Reusable pattern: snapshot interactive elements before each click, resnapshot after every UI update, and assert the audit trail/approval queue instead of assuming a click caused an external write.

## 2026-07-17 — Live GitHub relay acceptance flow

- Started `pnpm dev:github`, which generated an ignored local signing secret, created GitHub webhook `#653895042`, and forwarded `check_run` deliveries from a disposable Smee channel to `http://127.0.0.1:4310/webhooks/github`.
- Dispatched the manual-only **EventForge CI failure demo** workflow at `https://github.com/tebayoso/eventforge/actions`. Outcome: the workflow failed intentionally and GitHub delivered both queued and completed `check_run` events.
- Verified `http://127.0.0.1:4310/events` recorded the completed delivery as `signatureStatus: verified`, and `http://127.0.0.1:4310/actions` contained a pending remediation proposal rather than an automatic write.
- Attempted to reopen `http://localhost:5173/` in the Codex in-app browser. The runtime reported stale tab ownership after the prior tab cleanup, so browser assertions were not reused; the API-level acceptance evidence above remains valid.

Reusable pattern: for live webhook testing, keep the relay process open until the provider job reaches completion, then verify both the provider run and the local event/action APIs. If the in-app browser reports stale tab ownership, start a fresh browser session before relying on it for UI assertions.

## 2026-07-17 — Cloudflare Quick Tunnel webhook flow

- Started `pnpm dev:github`. EventForge launched `cloudflared` with an empty configuration, waited for the temporary `trycloudflare.com` health check to respond, then patched the existing GitHub webhook rather than creating a new one.
- Confirmed the stored public endpoint in `.eventforge/github-local-webhook.json` matched GitHub webhook `#653895042` and that the tunnel served `/health` successfully.
- Dispatched **EventForge CI failure demo** again. Outcome: GitHub completed the intentional failure, EventForge recorded a `verified` failed `check_run`, and the remediation action remained `pending`.

Reusable pattern: Quick Tunnel URLs change on each launch. Do not dispatch a provider test until the tunnel health check returns 200 and GitHub's webhook configuration matches the stored public `/webhooks/github` endpoint. Always run Quick Tunnels with an empty cloudflared config when the developer machine has unrelated named tunnels.

## 2026-07-17 — GitHub issue to Codex review flow

- Created GitHub issue [#1](https://github.com/tebayoso/eventforge/issues/1) with an explicit no-write review request. GitHub delivered the signed `issues` event to EventForge.
- Confirmed the first implementation correctly started Codex thread `019f71ce-21ca-7001-9c77-2b30380e0ae1` and created no action, but GitHub timed out because the webhook response waited for the 24-second Codex review.
- Changed verified webhook processing to start workflow analysis in the background and acknowledge it immediately. Redelivered the same GitHub delivery: GitHub recorded HTTP `202`, and EventForge completed fresh process-retained thread `019f71cf-98c8-7213-ace1-ed7d293e90a1` with an assessment and an empty action queue.
- Opened that thread in the Codex desktop app. The review identified the event as a test-only request and retained the read-only policy.

Reusable pattern: after opening a test issue, confirm the GitHub delivery is `202` before waiting for `/runs` to become `completed`; then assert `/actions` is an empty array. A slow agent must never delay the provider acknowledgment.

## 2026-07-18 — Forge artifact safety-review flow

- Started the deterministic local control plane with `EVENTFORGE_DEMO_MODE=true pnpm --filter @eventforge/control-plane start` and the console with `pnpm dev:console -- --host 127.0.0.1`.
- Opened `http://localhost:5173/console` in the `eventforge-forge` agent-browser session, selected **Forge draft**, and confirmed the validation notice appeared.
- Selected **Review artifact**. Outcome: the accessible dialog exposed requested scopes, scanner status, every generated file as keyboard-accessible tabs, and a read-only source pane before showing **Approve artifact**.
- Approved the validated demo artifact. Outcome: the dialog closed and the console confirmed that installation remains a separate local action; no generated connector was executed or hot-loaded.
- Captured the review state at `/tmp/eventforge-forge-review.png`.

Reusable pattern: exercise Forge Studio by creating a draft, opening **Review artifact**, checking the source tabs and scanner report, then approve only a validated demo artifact. Approval must not install or execute generated code.

## 2026-07-18 — Public landing submission CTA

- Opened `http://localhost:5173/` in the `eventforge-landing` agent-browser session.
- Verified the hero exposes **Watch the demo** and that it targets `https://youtu.be/pht3rrl--pE`; the console CTA remains routed to `/console`.

Reusable pattern: keep the demo CTA on the public landing page and verify its exact target without navigating away from the local application.

## 2026-07-17 — Console theme switcher smoke flow

- Started the Vite console and opened `http://127.0.0.1:5173/` in the `eventforge-theme-smoke` agent-browser session.
- Took an interactive accessibility snapshot. Outcome: the header exposed native buttons named **Use light theme** and **Use dark theme**, alongside the existing refresh control.
- Activated **Use dark theme** and verified `localStorage.eventforge-theme` became `dark`; captured `/tmp/eventforge-console-dark.png`.
- Focused **Use light theme** and pressed Space. Outcome: keyboard activation changed the page back to `light`, persisted `localStorage.eventforge-theme: light`, and the selected button reported `aria-pressed="true"` while the other reported `false`; captured `/tmp/eventforge-console-light.png`.
- Reloaded the console. Outcome: the document `data-theme`, CSS `color-scheme`, and saved preference all remained `light`. Browser error inspection was empty.
- Repeated the keyboard switch at a 375px viewport after the responsive-header adjustment. Outcome: **Use dark theme** remained discoverable by its accessible name, Space selected it, and the document width stayed equal to the 375px viewport (no horizontal overflow).

Reusable pattern: snapshot before every theme action, verify the selected button's `aria-pressed` state plus local storage, then reload to confirm the early initializer applies the persisted theme without waiting for React.

## 2026-07-17 — Cloudflare deployment CORS smoke flow

- Started an isolated control plane at `http://localhost:4311` with `EVENTFORGE_ALLOWED_ORIGINS=http://localhost:5174`, then served the Vite console at `http://localhost:5174` with `VITE_EVENTFORGE_API_URL=http://localhost:4311`.
- Opened the console in the `eventforge-cloudflare-smoke` agent-browser session. The command center, connector health, approval queue, and Forge Studio rendered; the browser console reported no application errors.
- Selected **Run GitHub CI demo**. Network evidence showed credentialed cross-origin preflights returning `204`, followed by the `POST /events/demo` returning `202` and console refresh requests returning `200`. The pending remediation proposal appeared in the approval queue.
- Screenshot captured at `/tmp/eventforge-cloudflare-cors-smoke.png`. A local `favicon.ico` request returned `404`; it did not affect the application flow.

Reusable pattern: test cross-origin production-style console wiring on isolated local ports, set the exact console origin in `EVENTFORGE_ALLOWED_ORIGINS`, and assert both the browser's preflight/POST sequence and the resulting approval state. Do not use this local test as evidence of Cloudflare Access, DNS, Tunnel, or custom-domain configuration.

## 2026-07-17 — EventForge landing-page validation

- Started the Vite console at `http://127.0.0.1:5176` and opened `/` in the `eventforge-landing` agent-browser session.
- Verified the landing page title, navigation, hero “Autonomy needs a witness,” the investigation trace, principles, decision ledger, and final console CTA rendered in the accessibility tree. Browser console showed only Vite/React development messages, with no application errors.
- Captured the full-page desktop visual at `/tmp/eventforge-landing.png` and visually inspected its layout: the dark field-note system, visible investigation trace, warm proof section, and mint closeout all remained distinct and readable.
- Followed the **Open console** navigation to `/console`. The existing operations console rendered with its dashboard headings and controls, confirming the landing page did not replace it.

Reusable pattern: validate the marketing route and the preserved application route separately. For this Vite SPA, `/console` is selected client-side and is covered by the Worker static-assets SPA fallback in production.

## 2026-07-17 — Landing page opened for review

- Started Vite at `http://127.0.0.1:5176` and opened the landing page in the headed `eventforge-landing-live` browser session for live review.
- Confirmed the loaded document title is `EventForge — Autonomy needs a witness`.

## 2026-07-17 — Landing page value and readability refinement

- Reopened `http://127.0.0.1:5176/` in the headed `eventforge-landing-live` browser session after the copy and typography update. Confirmed the document title is `EventForge — One place for every webhook` and the accessibility tree includes the new hierarchy: “One place for every webhook. Less noise.”, “More clarity around the work that matters.”, and “Turn webhook noise into useful work.”
- Captured and visually inspected `/tmp/eventforge-landing-refined.png`. The reduced display scale and sans-serif headings keep the visual character while making the hero, value cards, and supporting copy legible at desktop size.
- Selected **What it solves** and confirmed the in-page navigation resolves to `/#problem`. Reopened `/console` and confirmed the existing operations command center still renders with its dashboard, event feed, approval queue, and Forge Studio controls; returned the live browser to `/` for review.
- Browser console contained only Vite/React development notices, with no application errors.

Reusable pattern: after changing a marketing route, validate the page’s outcome-led headings in the accessibility tree, test at least one in-page anchor, then open the retained application route before returning the browser to the marketing page.

## 2026-07-18 — Production-hardening acceptance flow

- Started the credential-free control plane on `http://127.0.0.1:4310` and Vite console on `http://localhost:5173/console`; used the `eventforge-quality` agent-browser session.
- Confirmed the exact-origin CORS boundary: `http://127.0.0.1:5173/console` reported offline while the configured `http://localhost:5173` origin reported online. Browser console inspection contained no application errors.
- Switched light and dark themes. Outcome: both `document.documentElement.dataset.theme` and `localStorage.eventforge-theme` updated, with no CSP error. Repeated the console snapshot at a 390×844 viewport and found no missing primary workflow controls.
- Ran the GitHub CI demo, opened two proposals produced by the normal run plus an MCP-started analysis, rejected one and approved the other. Outcome: both linked agent runs moved from `waiting_for_approval` to `completed`; the approved run stated that execution still requires a dedicated policy-controlled worker.
- Created a Forge draft from “Create a GitHub read-only connector for deployment status events.” Outcome: requested scopes were exactly `events:read` and `github:read`; `provider:write` was absent. Opened the keyboard-accessible file tabs, closed the dialog with Escape, then approved the reviewed draft. No install or execution occurred.
- Stopped the control plane while leaving the console open. Outcome: status changed to **Control plane degraded**, cached data remained visible, and each affected panel said its refresh failed. Restarting the control plane returned the status to online without reloading the browser.
- Sent an invalid GitHub delivery with `x-eventforge-demo: true` directly to `/webhooks/github`. Outcome: HTTP `401`; demo mode cannot bypass provider signatures. Ran the normal `/events/demo` flow afterward and confirmed the approval proposal still appeared.
- Evidence is stored under `workfiles/agent-browser/screenshots/`: `quality-console-initial.png`, `quality-console-dark.png`, `quality-console-mobile.png`, `quality-console-decisions.png`, `quality-forge-approved.png`, `quality-console-degraded.png`, and `quality-console-final.png`.

Reusable pattern: keep the exact configured browser origin, verify mutation outcomes in both the affected resource and the audit/run timeline, test cached degraded state by stopping only the API, and treat public webhook routes as signed-only even when demo mode is enabled.

## 2026-07-18 — eventforge.dev production landing deployment

- Deployed the console static-assets Worker to the `eventforge.dev` custom domain as Cloudflare version `859e9d5f-5b27-4113-a124-51534cef0821`.
- Verified Cloudflare public DNS returned both IPv4 and IPv6 records. The local macOS resolver retained its pre-deploy negative answer, so the `eventforge-release-resolved` agent-browser session used a temporary Chromium host resolver rule for the already-published Cloudflare address; no application or DNS configuration was changed for this workaround.
- Opened `https://eventforge.dev/` and confirmed the production title, primary navigation, “One place for every webhook. Less noise.” hero, console CTA, and exact demo target `https://youtu.be/pht3rrl--pE`.
- Followed **See your event inbox** and confirmed the final URL was `https://eventforge.dev/console`. The console rendered its event feed, connector health, approval queue, run log, Forge Studio, and audit controls while truthfully reporting **Control plane offline** because this release deploys only the static shell.
- Browser error inspection and filtered console output were empty. Direct HTTPS checks returned `200` for `/` and the `/console` SPA fallback with CSP, permissions policy, referrer policy, anti-framing, and MIME-sniffing headers.
- Evidence is stored at `workfiles/agent-browser/screenshots/eventforge-dev-live.png` and `workfiles/agent-browser/screenshots/eventforge-dev-console.png`.

Reusable pattern: after a new custom-domain attachment, distinguish public DNS propagation from a developer machine's negative DNS cache. Verify authoritative/public resolvers and HTTPS independently, then use a temporary browser resolver override only for local acceptance testing; never commit that override or treat it as production configuration.

## 2026-07-18 — GitHub pull request to local Codex review

- Started `pnpm dev:github` with the local named tunnel `eventforge-local`. EventForge verified `https://eventforge-hooks.planeflare.com/health`, then patched GitHub webhook `#653895042` to the signed `/webhooks/github` endpoint with `pull_request`, `pull_request_review`, and `issue_comment` subscriptions alongside the existing issue and check-run events.
- Pushed commit `40ac4c7` to PR [#3](https://github.com/tebayoso/eventforge/pull/3). GitHub delivery `3831934487258726400` sent `pull_request:synchronize` and received HTTP `202` in 0.69 seconds.
- Confirmed local event `1edbf54f-d29e-43ea-a8f9-e6bc0aae0a38` recorded `signatureStatus: verified`, repository `tebayoso/eventforge`, PR `#3`, and the exact pushed SHA.
- Waited for the background read-only review. Outcome: run `1f374ffc-62e6-41ee-90f3-ea81f93335a3` completed in Codex thread `019f758c-2523-71d3-9b19-a8a89ddaae4d`; `/actions` remained empty. Opened the resulting task in the Codex desktop app.

Reusable pattern: keep `pnpm dev:github` running, require public health plus an active matching GitHub hook before pushing, assert the provider delivery returns `202`, then correlate the delivery GUID to a verified local event and wait independently for the run's `threadId`. A PR review must remain read-only and leave `/actions` empty.

## 2026-07-20 — Production console deployment and backend readiness check

- Deployed the current static console with `VITE_EVENTFORGE_API_URL=https://api.eventforge.dev` to the `eventforge.dev` Worker custom domain as Cloudflare version `9ec9b09c-68ae-4e86-9052-12efb15126de`.
- Opened `https://eventforge.dev/` in the `eventforge-e2e` agent-browser session. The production title, navigation, hero, console CTA, and demo link rendered successfully; browser console and error inspection were empty.
- Followed **Open console** to `https://eventforge.dev/console`. The SPA fallback rendered the operations console, themes, refresh control, demo controls, event feed, connector health, approvals, run log, Forge Studio, and audit panel.
- The console truthfully reported **Control plane offline**. Independent resolution checks confirmed `api.eventforge.dev` has no DNS record, and Cloudflare inventory confirmed the existing `eventforge-local` tunnel has no active connectors.
- Did not create API or hook DNS records: Cloudflare documents that DNS pointing to an inactive tunnel produces error 1016, and the repository's remote entry point still rejects startup without a real authenticator while operational repositories remain process-local.
- Evidence is stored at `workfiles/agent-browser/screenshots/eventforge-production-2026-07-20.png` and `workfiles/agent-browser/screenshots/eventforge-production-console-2026-07-20.png`.

Reusable pattern: deploy the console with its intended API origin, verify the landing and SPA routes independently, then treat an offline console as a backend readiness failure. Never make production DNS resolve by pointing it at a tunnel with no connectors or by bypassing EventForge's remote-mode safety gates.

## 2026-07-20 — Cloudflare-native preview foundation acceptance

- Opened `https://eventforge.dev/` at desktop and 390×844 mobile viewports. The production title, navigation, webhook-focused hero, value sections, and console links rendered; browser console and error inspection were empty.
- Opened `https://eventforge.dev/console` at 1440×900. The operations shell rendered all primary controls and truthfully remained **Control plane offline** because the authenticated API is still gated.
- Opened `https://eventforge-cloud-preview.jorge-b9f.workers.dev/health`. Outcome: HTTP-rendered JSON reported `environment: preview` and `ingress: gated` after the acceptance canary.
- Opened `/v1/events` without an identity. Outcome: structured `503 AUTH_GATED`; no unauthenticated API surface was exposed while Better Auth and tenant repositories remain incomplete.
- Before the browser pass, a disposable signed canary returned `202`, produced one encrypted R2 payload reference, one D1 event/outbox/audit chain, and reached `processed` through the Queue consumer. The Worker was redeployed with ingress disabled immediately afterward.
- Evidence is stored at `workfiles/agent-browser/screenshots/cloudflare-foundation-desktop.png`, `cloudflare-foundation-mobile.png`, `cloudflare-console-desktop.png`, `cloudflare-preview-health-mobile.png`, and `cloudflare-auth-gate.png`.

Reusable pattern: keep hosted preview ingress disabled by default, temporarily enable only a disposable signed canary after secret rotation, reconcile R2, D1, outbox, audit, and Queue state, then redeploy the gate and independently verify it through both the health endpoint and an unauthenticated API request.

## 2026-07-20 — Production console authentication audit

- Opened `https://eventforge.dev/console` in a clean `eventforge-auth-audit` browser session. Outcome: the static operations shell returned `200` and rendered without any login, redirect, session cookie, or authentication challenge.
- Network inspection showed the shell immediately attempted unauthenticated requests to `https://api.eventforge.dev/events`, `/actions`, `/runs`, `/audit`, `/memory`, `/connectors`, and `/forge`.
- DNS inspection found no records for `api.eventforge.dev` or `hooks.eventforge.dev`. The only hosted backend deployment remains the isolated `eventforge-cloud-preview` Worker; its unauthenticated `/v1/events` endpoint returned structured `503 AUTH_GATED`.
- Conclusion: the static console deployment completed, but the authenticated hosted product deployment did not. `/console` must not be represented as production-ready until Better Auth, session-aware route protection, tenant repositories, and the production API custom domain are deployed and pass an unauthenticated redirect/denial test.

Reusable pattern: test protected application shells in a clean browser context, verify both the document response and downstream API calls, and require an explicit login redirect or denial before calling the frontend deployment complete.

## 2026-07-20 — Production custom-domain remediation

- Provisioned isolated production D1 control/event databases, private R2 payload storage, ingestion Queue, and DLQ; applied both initial migrations and installed production-only payload and canary secrets.
- Deployed `eventforge-cloud-production` version `33e20d69-fa9b-4f09-8f4f-8c3d87641405` to Worker custom domains `api.eventforge.dev` and `hooks.eventforge.dev`. Cloudflare created their DNS and TLS without a Tunnel.
- Verified both hostnames through Cloudflare, Google, and Quad9 public resolvers. TLS verification succeeded; production health reports `ingress: gated`. The API host returns `503 AUTH_GATED` for `/v1/events` and does not expose webhook routes; the hook host returns `404` for API routes and `503 INGRESS_GATED` for unsigned canary ingress.
- Deployed `eventforge-console` version `5221b330-28be-4ba3-af3f-33b0bed4ca0a`. A Worker-first route now intercepts `/console` and returns a non-cacheable `503` authentication gate instead of the operations SPA.
- A clean browser confirmed the new console gate and `hooks.eventforge.dev` production health. The local macOS/Chromium resolver still held the earlier negative answer for `api.eventforge.dev`; public DNS, an explicit-address TLS request, and a temporary Chromium host-resolver rule all reached the new API Worker successfully. The resolver override was used only for acceptance and was not saved to production configuration.
- Evidence is stored at `workfiles/agent-browser/screenshots/production-console-auth-gate.png`, `production-api-health.png`, and `production-hooks-health.png`.

Reusable pattern: attach originless Worker custom domains through Wrangler, verify at three public resolvers plus TLS, isolate API and hook routes by hostname, and treat a local negative-DNS cache separately from authoritative deployment state.

## 2026-07-20 — Fresh-clone local acceptance

- Cloned `origin/main` at `a741795` into an empty temporary directory, copied only `.env.example`, installed with the frozen lockfile, and passed the complete `pnpm quality` release gate.
- Started the default credential-free control plane and console from that clone. Opened `http://localhost:5173/`, followed **Open console**, and confirmed the console initially reported **Control plane online** with no browser errors.
- Ran **Run GitHub CI demo**, opened the pending remediation proposal, and selected **Approve action**. Outcome: the run completed and the console confirmed the decision was recorded without executing a write.
- Created and reviewed a Forge Studio draft, inspected the generated artifact dialog, and approved it. Outcome: the console explicitly kept installation as a separate action; no connector was executed or hot-loaded.
- Reloaded `/console` under an iPhone 14 viewport. The API remained alive, but the console became offline because the seven-resource polling cycle and normal interactions exhausted the shared 120-request/minute limiter. Raised only the loopback-local default to 600 requests/minute and retained the 120-request remote default; added a regression test for this boundary.
- Repeated the mobile reload after the fix, sent 160 additional loopback requests inside one minute, and waited through another polling cycle. All 160 requests returned `200` and the console remained **Control plane online**.
- Browser console output contained only Vite/React development notices. Evidence is stored at `workfiles/agent-browser/screenshots/fresh-installer-mobile.png`.

Reusable pattern: validate installation from an empty remote clone, not an existing working tree; exercise enough polling and mutations to cross at least one refresh boundary; and distinguish a live API from a UI that has entered a rate-limited degraded state.

## 2026-07-20 — Product landing and pricing expansion

- Started the Vite console at `http://127.0.0.1:5173/` and opened the public landing page in the `eventforge-landing` agent-browser session.
- Verified the desktop accessibility tree includes the operational-control-plane hero, Product, Pricing, Docs, GitHub, and console navigation, plus the live GitHub star/fork badge.
- Verified the page now presents verified ingress, operational context, replay, bounded reactions, equal API/CLI/MCP/OpenTelemetry/Console surfaces, the gateway/operations/reactions roadmap, Free/Team/Pro/Business pricing, and the passwordless Codex install command.
- Captured and visually inspected desktop, full-page, and iPhone 14 renders at `workfiles/agent-browser/screenshots/eventforge-landing-product-desktop.png`, `eventforge-landing-product-full.png`, and `eventforge-landing-product-mobile.png`.
- Browser error inspection was empty. The GitHub stats request gracefully falls back to zero when the public API is unavailable.

Reusable pattern: for marketing changes, validate both the accessibility hierarchy and a full-page visual at desktop and mobile widths; external proof badges must have a deterministic fallback and documentation links must target a real public URL.

## 2026-07-20 — Expanded landing page production deployment

- Deployed the updated static console Worker to `https://eventforge.dev/` as Cloudflare version `9548169c-93a0-4a78-a0e5-55d86949b9ce`.
- Reopened the production landing page at desktop width and verified the new hero, Product, Pricing, Docs, GitHub, roadmap, four pricing tiers, Codex install panel, and final console CTA in the accessibility tree.
- Confirmed the live GitHub API badge resolves to `0 stars` and `0 forks` for `tebayoso/eventforge`; when the public GitHub API is unavailable the UI shows an em dash instead of inventing a count.
- Verified the production CSP includes `https://api.github.com`, so the live star/fork request is allowed. Browser error inspection was empty.
- Screenshot captured at `workfiles/agent-browser/screenshots/eventforge-production-landing-new.png`.

Reusable pattern: when adding a third-party proof badge, update both the HTML CSP and the deployed Worker `_headers`; test the live response headers and the browser request, not only the local Vite page.

## 2026-07-20 — Enterprise pricing follow-up

- Added the Enterprise contracted-band tier and transparent Team/Pro overage notes to the pricing section.
- Deployed the follow-up static Worker as Cloudflare version `e9df48a2-0095-48bc-8d06-b7e6fda207fc`.
- Opened `https://eventforge.dev/?release=33330e0` to bypass the browser's prior asset cache and verified Free, Team, Pro, Business, and Enterprise headings, live GitHub stars, and no browser errors.
- Screenshot captured at `workfiles/agent-browser/screenshots/eventforge-production-landing-enterprise.png`.

## 2026-07-20 — IsItAgentReady production audit

- Opened `https://isitagentready.com/`, entered `https://eventforge.dev/`, and ran the public Cloudflare agent-readiness scan.
- Final result: **Level 5 — Agent-Native**. Passing checks include robots.txt and AI rules, sitemap, Link headers, Markdown negotiation, Content Signals, API Catalog, OAuth/OIDC discovery, OAuth Protected Resource metadata, Auth.md registration metadata, MCP Server Card, A2A Agent Card, Agent Skills index, and WebMCP.
- The only failing enabled check is DNS-AID. The authoritative zone has no `_index._agents.eventforge.dev`, `_mcp._agents.eventforge.dev`, or `_a2a._agents.eventforge.dev` SVCB/HTTPS/TXT entrypoint records. This requires Cloudflare DNS write access; the current Wrangler identity exposes zone read but not DNS edit permission.
- Independent production checks confirmed `https://eventforge.dev/` returns Markdown when requested with `Accept: text/markdown`, publishes the machine-readable discovery documents, and includes agent-useful Link headers. `https://eventforge.dev/console` remains a deliberate `503` sign-in gate.
- Browser error inspection was empty. Final score evidence is captured at `workfiles/agent-browser/screenshots/eventforge-agent-ready-final.png`.

Reusable pattern: run the evaluator after deployment, inspect its JSON evidence rather than relying on the headline score, fix HTTP discovery contracts in the Worker, and treat DNS-AID as a separate authoritative-zone change that cannot be completed with a zone-read-only token.

## 2026-07-21 — Landing page readability pass

- Started the console Vite app at `http://127.0.0.1:5173/` and captured the landing page at 1440×1000 and 390×844 viewports.
- Increased the responsive type ramp, body copy line-height, navigation/CTA sizing, card copy sizing, code sample readability, and section breathing room. Mobile actions now stack with comfortable touch targets instead of compressing the copy.
- Desktop and mobile screenshots were visually inspected at `workfiles/agent-browser/screenshots/eventforge-readable-desktop.png` and `workfiles/agent-browser/screenshots/eventforge-readable-mobile.png`.
- Browser error inspection was empty.

Reusable pattern: treat monospace labels and card metadata as secondary—not a reason to shrink primary copy—and set mobile minimums explicitly so responsive interpolation cannot make the page unreadable.

- Deployed the readability pass to `https://eventforge.dev/` as Cloudflare version `6e3ec32d-cdaf-48df-b4ea-1f7b40d6dc40`, then reopened it with a cache-busting query at desktop and mobile widths.
- Production screenshots are stored at `workfiles/agent-browser/screenshots/eventforge-readable-production-desktop.png` and `workfiles/agent-browser/screenshots/eventforge-readable-production-mobile.png`; browser error inspection remained empty.

## 2026-07-21 — EventBridge brand deployment

- Rebranded the public product experience to **EventBridge** with a new accessible SVG bridge/signal mark at `/eventbridge-mark.svg`.
- Wired the mark into the landing-page header and favicon, updated the console header, page title, social metadata, agent markdown, Auth.md, MCP server card, A2A card, agent-client manifest, and agent-skill descriptions.
- Preserved `eventforge.dev`, the `eventforge` package/CLI command, API hostnames, and discovery identifiers that existing clients rely on. The public brand is EventBridge; EventForge remains the compatibility namespace.
- Deployed `eventforge-console` as Cloudflare version `68df6e51-cbfa-4d0d-916f-b7ef3b28a33a`.
- Opened `https://eventforge.dev/?brand=eventbridge` with agent-browser at 1440×1000 and 390×844. The live title is `EventBridge — The operational control plane for every hook`, the bridge mark is visible in both layouts, and browser error inspection was empty.
- Screenshots are stored at `workfiles/agent-browser/screenshots/eventbridge-brand-production-desktop.png` and `workfiles/agent-browser/screenshots/eventbridge-brand-production-mobile.png`.

Reusable pattern: separate visible product branding from stable protocol/package identifiers, and verify the actual deployed favicon, metadata, responsive mark, and browser console rather than only checking source files.

## 2026-07-21 — Concealed waitlist and production analytics hooks

- Added a direct, non-indexed waitlist route at `https://eventforge.dev/waitlist`; it is intentionally absent from primary navigation and sitemap.
- Verified the live page at 1440×1000 and 390×844 with agent-browser. The final dark-theme layout is readable, responsive, and keeps the honeypot out of the accessibility tree. Browser error inspection was empty.
- Screenshots are stored at `workfiles/agent-browser/screenshots/eventforge-waitlist-production-desktop-v2.png` and `workfiles/agent-browser/screenshots/eventforge-waitlist-production-mobile-v2.png`.
- Verified `x-robots-tag: noindex, nofollow, noarchive` and `cache-control: no-store` on the concealed route.
- Verified the production API waitlist contract: allowed-origin preflight returns `204`, invalid email returns structured `400`, honeypot submissions return a non-persisting `202`, a valid test signup persists once in D1, duplicates return `alreadyRegistered: true`, and the test row was removed after acceptance.
- Added optional anonymous PostHog capture and GA4 `gtag` instrumentation through build-time public IDs. No PostHog project key or GA4 Measurement ID exists in the current local/Cloudflare configuration, so production is safely opt-in until those account values are supplied.
- API Worker deployed as `414c367b-2768-4bd1-9b3f-06c2b7d6c390`; console Worker deployed as `f2cc68cc-3f7e-47e9-b2d6-24e88d795994`.

Reusable pattern: keep a marketing capture route out of discovery, enforce origin/consent/honeypot/rate limits at the edge, and test persistence plus duplicate behavior rather than treating a successful browser response as proof of storage.

## 2026-07-21 — 1.0-rc analytics configuration

- Added the public runtime analytics manifest at `/analytics-config.json` with the supplied PostHog project key, US capture host, and GA4 Measurement ID.
- Deployed the `1.0-rc` console build as Cloudflare version `0d560b3e-c956-4dbc-9415-e90a8ae1b1e4`.
- Verified the live manifest returns `200 application/json` and the production CSP allows the PostHog capture hosts, Google Analytics endpoints, and Google Tag Manager script.
- Opened `https://eventforge.dev/waitlist?release=1.0-rc` in agent-browser, waited for network idle plus analytics initialization, and confirmed the EventBridge title with no browser errors.

Reusable pattern: keep client analytics identifiers in a public runtime manifest so deployments are reproducible without putting private credentials in build logs or shell history.

## 2026-07-22 — GA4 production tag deployment

- Built the console from `main` with the production GA4 Measurement ID in `apps/console/.env.production`; the emitted asset contained `G-2E80P0BMCR`.
- Deployed the rebased `main` console to `https://eventforge.dev/` as Cloudflare version `882caed1-8936-470d-bedc-40af3f2ff6f3`.
- Opened the production landing page in fresh `eventforge-ga4-*` agent-browser sessions. The page rendered correctly, `window.dataLayer` contained the GA4 `config` command with privacy flags, and `https://www.googletagmanager.com/gtag/js?id=G-2E80P0BMCR` returned `200`.
- Browser error and console inspection were empty. The automated browser did not expose a separate Google Analytics collection beacon, so authoritative ingestion confirmation remains the GA4 Realtime/DebugView report.
- Reopened `https://eventforge.dev/console`; it retained the intentional `503` sign-in gate after deployment.
- Visually inspected the full production landing page captured at `workfiles/agent-browser/screenshots/eventbridge-ga4-production-2026-07-22.png`.

Reusable pattern: verify analytics releases at four layers—compiled identifier, live bundle, third-party loader plus queued configuration, and the provider's realtime report—without treating a successful script download alone as proof of event ingestion.

## 2026-07-22 — Production CSP and analytics repair

- Reproduced the production CSP warning and the blocked Cloudflare Web Analytics script on `https://eventforge.dev/`.
- Updated both the HTML meta policy and Worker `_headers` policy with the documented GA4 and Cloudflare analytics sources. Kept `frame-ancestors 'none'` in the HTTP response policy and removed it from the unsupported meta policy.
- Replaced the GA command queue's rest-parameter arrays with Google's required `arguments` objects and disabled the automatic config page view so the shared explicit `page_view` is counted once.
- Deployed the final console as Cloudflare version `a16fa9cc-d78a-4b0a-be01-597cd8794462` and verified asset `index-D3ktepWR.js` in a fresh non-automation browser session.
- Confirmed one GA4 `page_view` request to `https://www.google-analytics.com/g/collect` returned `204`, the GA client and `_ga` cookies initialized, the Cloudflare Insights script returned `200`, and the first-party `/cdn-cgi/rum` POST returned `204` after the page became hidden.
- Browser console and page-error inspection were empty; the final data-layer config contained `send_page_view: false`.

Reusable pattern: after an edge deployment, verify the exact hashed asset loaded before interpreting analytics traces; a still-cached prior bundle can make a correct release look broken during propagation.

## 2026-07-22 — EventForge anvil rebrand

- Used agent-browser `0.28.0` against `http://127.0.0.1:5173/` at 1440×1000 and 390×844 before deployment. Confirmed one app root, no horizontal overflow, no visible `EventBridge` text, and `/eventforge-mark.svg` in the brand slot.
- Opened the SVG directly and visually confirmed the accessible orange, cream, and mint anvil at favicon and enlarged sizes. Local evidence is stored in `eventforge-anvil-local-desktop.png`, `eventforge-anvil-local-mobile.png`, and `eventforge-anvil-mark-local.png`.
- Deployed `eventforge-console` to `https://eventforge.dev/` as Cloudflare version `486b18e7-1928-44fe-aad1-743d52b871e5`.
- Reopened production with a cache-busting query at desktop and mobile widths. Verified the EventForge title, favicon, social title, anvil asset, landing copy, concealed waitlist, `503` sign-in gate, Markdown negotiation, Auth.md, agent card, MCP card, client manifest, and Agent Skills discovery. None of the live surfaces contains the retired brand.
- Confirmed the GA4 loader returned `200`, its `page_view` collection request for `G-2E80P0BMCR` returned `204`, the Cloudflare Insights loader returned `200`, and `/cdn-cgi/rum` returned `204`. Browser console and page-error inspection were empty.
- Production evidence is stored in `eventforge-anvil-production-desktop.png`, `eventforge-anvil-production-mobile.png`, and `eventforge-anvil-production-console.png`.

Reusable pattern: verify a rebrand across visible UI, compact SVG rendering, HTML metadata, telemetry labels, protected fallbacks, and machine-readable discovery. Use a plain 390×844 viewport for very tall full-page mobile captures; high-DPI device emulation can produce stitched-image artifacts even when the DOM has one root.

## 2026-07-22 — GitHub publish check (connector trust branch)

- URL: `https://github.com/tebayoso/eventforge/compare/1.0-rc...codex%2Fissue-8-forge-connectors?expand=1`
- Outcome: the branch comparison resolved to commit `5190f02`, but the browser was logged out (`Sign in` shown). GitHub CLI also reported its active token invalid, so no draft PR or review comment was created.
- Reusable pattern: confirm the exact base/head comparison URL before publishing; authenticated GitHub browser or CLI state is required for PR creation and comments.

## 2026-08-28 — v1.0.0-rc.1 live-surface verification

- Session: agent-browser 0.26.0 against production and beta after deploying
  console Workers `61fd8efe` (apex) and `82a81c4f` (beta).
- Desktop (default viewport) and mobile (`set viewport 390 844`) both checked.
- `https://eventforge.dev/` — landing renders; hero, features, pricing, GitHub
  nav. Screenshot: `release-prod-landing.png`, `release-prod-landing-mobile.png`.
- `https://eventforge.dev/features` — 24-capability status page. Screenshot:
  `release-prod-features.png`.
- `https://eventforge.dev/console` — 503 "Sign-in is not enabled yet."
  Screenshots: `release-prod-console-gated.png`,
  `release-prod-console-gated-mobile.png`.
- `https://eventforge.dev/waitlist` — work-email form + "Join the waitlist".
  Screenshot: `release-prod-waitlist.png`.
- `https://beta.eventforge.dev/` — same landing, analytics blanked at
  `/analytics-config.json`. Screenshot: `release-beta-landing.png`.
- `https://beta.eventforge.dev/console` — hosted sign-in SPA (email, password,
  "Sign in by email"). Screenshots: `release-beta-console-signin.png`,
  `release-beta-console-signin-mobile.png`. Switching to email-link shows
  "Email me a link". Screenshot: `release-beta-email-link.png`.
- `https://beta.eventforge.dev/features` — same capability page as production.
  Screenshot: `release-beta-features.png`.
- Note: JOIN THE BETA pricing CTAs hash to `/#install`, not `/waitlist`.
  GitHub star/fork counts rendered as `0` in the nav; not a deploy regression
  of this RC.

Reusable pattern: after a dual-env console deploy, curl `/analytics-config.json`
on beta before trusting the UI, then walk `/`, `/features`, `/console`, and
`/waitlist` on both hosts at 1280 and 390 widths. Production `/console` must
stay 503 while beta `/console` must serve the sign-in SPA.

## 2026-08-28 — production sign-in, waitlist, beta retired

- Deployed console `1127337d` and API `6c29a9ac` from `36a3cd6`.
- `https://eventforge.dev/console` is the hosted sign-in SPA with Turnstile
  (`captchaRequired: true`). Footer links to `/waitlist`. No 503 gate.
- Landing `#waitlist` has the work-email form; pricing CTAs say Join the waitlist.
- `/waitlist` standalone form works; POST `/v1/waitlist` from
  `Origin: https://eventforge.dev` returns `202 accepted`.
- `beta.eventforge.dev` 301s to `https://eventforge.dev` with path preserved.
  `eventforge-console-beta` Worker deleted.
- Screenshots: `release-prod-landing-waitlist.png`,
  `release-prod-console-signin.png`, `release-prod-waitlist-page.png`.

Reusable pattern: after enabling production auth, curl
`/api/auth/config` on the console origin (not the API host) so you are testing
the same-origin proxy and the cookie domain together. Confirm `captchaRequired`
is true before calling the login form done.

## 2026-08-28 — destination portal, invite, replay reason

- API production `225f56f9`, preview `8bcf886d`, console `ba6e40a6`.
  `PUBLIC_INGRESS_ENABLED`, `DURABLE_DELIVERY_ENABLED`, `MONITORING_ENABLED`
  remain `"false"`. Health: `ingress: gated`. Unauthenticated `/v1` is
  `503 AUTH_GATED`.
- `https://eventforge.dev/console` still the sign-in SPA (Turnstile, email
  link). Destination portal is behind session; bundle includes "Add endpoint"
  and "Signing secret". Console Worker proxies `/v1` same-origin.
- Production CONTROL_DB now has owner `jorge@pox.me` on workspace EventForge
  (`77fe6619-…`). First sign-in is the email link (no password row yet).
- Screenshots: `portal-prod-landing.png`, `portal-prod-console-signin.png`,
  `portal-prod-features.png`, `portal-prod-waitlist.png`, plus `-mobile`
  variants at 390×844.
- Could not click through Destinations live: no session in this agent run.

Reusable pattern: after a webhook API deploy, curl `/health` and an
unauthenticated `/v1/workspaces/:id/installations` before opening `/console`.
Confirm the three delivery flags are still false unless a signed preview
canary is in progress. Destination UI verification requires a session cookie
on `eventforge.dev` (SameSite=Strict via the `/v1` proxy).

## 2026-08-28 — local Destinations E2E on https://dev.eventforge.dev

- Stack: `./dev.sh start --remote` (preview D1/R2, Worker local). Named tunnel
  `eventforge-dev` fronts Vite at `https://dev.eventforge.dev`. This Mac's
  getaddrinfo still NXDOMAINs the name; `dig @1.1.1.1` and `curl --resolve`
  succeed. Browser session: `eventforge-local-dev` with
  `--host-resolver-rules=MAP dev.eventforge.dev 172.67.170.94`.
- Signed in as `jorge@pox.me` via `POST /api/auth/request` (`devToken` because
  `ENVIRONMENT=development`, no EMAIL binding) then
  `https://dev.eventforge.dev/console?token=…`.
- UI: **New route** → `custom · 0146bacd` (`ad404b28-…`). **Add endpoint**
  `https://webhook.site/d87e2471-6ca0-407b-9504-c5bf5b3a1510` (secret shown
  once). **Send event** `invoice.paid` → `202` accepted event
  `8187a7b5-6cdf-436c-b2d4-9e7235415c9e` for 1 endpoint. Delivery
  `ae46d663-…` status `accepted`, 0 attempts.
- First send-event click missed because the form sat below the 800×600 fold;
  `scrollintoview` then click. Replay `503`: "Durable delivery release gates
  have not passed." webhook.site inbox: 0 requests.
- UI gaps fixed: `optionalString` now treats JSON `null` as absent (D1
  `safe_reason` was `null`, list crashed with `Invalid response field:
  delivery.safeReason.`); Destinations shows Loading… instead of empty lists
  while remote D1 is in flight. `dev.sh` always starts the tunnel.
- Screenshots: `local-dev-destinations-empty.png`,
  `local-dev-endpoint-added.png`, `local-dev-send-event-form.png`,
  `local-dev-delivery-accepted.png`, `local-dev-replay-gated.png`,
  `local-dev-operations.png`.
- Production flags untouched. Do not use `eventforge.dev` for this loop.

Reusable pattern: build against `https://dev.eventforge.dev`, not production.
If getaddrinfo fails, start the tunnel anyway and MAP the host in Chrome.
Always `scrollintoview` before clicking Destinations actions below the fold.
Request a `devToken` from `/api/auth/request` on the public origin; the SPA
holds `requestToken` in memory so a full reload requires a new link.

## 2026-08-28 — admin dashboard sidebar on https://dev.eventforge.dev

- Signed in as `jorge@pox.me`. Hosted console is now a persistent **Sidebar**
  (`nav[aria-label="Sidebar"]`) with one active view: Routes, Endpoints,
  Send event, Deliveries, Members, API keys, Operations.
- Default view **Routes**: existing `custom · 0146bacd-… · active`. **New route**
  is the primary control. Other view headings are not on the page.
- **Endpoints**: route select + Add endpoint; existing webhook.site destination.
- **Send a test event**: invoice.paid + JSON payload + Send event.
- **Deliveries**: accepted event still listed; Replay present.
- **Members**: `jorge@pox.me · owner` + Invite form.
- **API keys**: empty list then **Create key** → token shown once, list
  `publisher · efk_f098e67c… · Never used`. Production flags untouched.
- **Operations**: existing command center (`Run GitHub CI demo`) mounts as the
  last sidebar view; sidebar stays.
- Mobile 390×844: sidebar stacks above the pane; Routes heading still unique.
- Screenshots: `admin-routes.png`, `admin-endpoints.png`, `admin-publish.png`,
  `admin-deliveries.png`, `admin-members.png`, `admin-api-keys.png`,
  `admin-api-keys-created.png`, `admin-operations.png`, `admin-routes-mobile.png`.

Reusable pattern: after a dashboard change, click every sidebar item and assert
`document.querySelectorAll('h2')` contains only that view’s heading. Create-key
and replay stay on their own views so a one-pager dump cannot regress.


## 2026-09-09 — auth/waitlist security acceptance

Session `eventforge-security`, agent-browser 0.37.1 (latest at verification).

1. Opened `http://localhost:8891/waitlist` against disposable workerd on port 8890.
   Filled reserved test email; verified consent=false returns a consent error.
   Set consent via the real checkbox click, submitted, and observed persistent
   success text. No production dependency used by this local fixture.
2. Requested a local-only devToken for a seeded identity and opened `/console`
   with that token. Dashboard rendered; URL token was removed. Reload preserved
   authentication. Sign out returned to the intentional loopback operations UI.
3. Opened `https://eventforge.dev/waitlist` after deployment. Submitted reserved
   `security-audit-20260909@example.test`, observed success; remote D1 confirmed
   one row. A second API request returned the same `{accepted:true}` response.
   Removed only the synthetic row after checking it.
4. Opened `https://eventforge.dev/console`; password sign-in stayed captcha-gated;
   email-link mode rendered. No real password, captcha bypass, or email sent.
5. HTTP checks: malformed/null bodies return 400, hostile Origin login returns 403,
   invalid verification token returns 400, health returns 200, console returns
   no-store/no-referrer. Python urllib received an edge 403 on a health request;
   curl and browser succeeded, so use the actual browser or curl for smoke checks.

Reusable pattern: refresh snapshots after actions and verify actual DOM state.
The CLI checkbox action reported success without changing checked state in this
session; a DOM `.click()` on the observed checkbox followed by a fresh snapshot
confirmed checked=true. Synthetic consent only; no user privacy agreement accepted.

Screenshots: `screenshots/security-production-waitlist.png`,
`screenshots/security-production-signin.png`, `screenshots/security-local-waitlist.png`.
Local screenshot records the negative consent check. Successful local signup and
authentication were verified through browser text and snapshots.

Remaining acceptance: authorized production account for real email delivery,
Turnstile/password success, and authenticated session/logout checks.

Final console version `1b8f90c2-00c9-4304-9dd1-32ab4d28591e` fixes returning from email mode to password mode. A regression test covers captcha removal and remount.
Production browser verified the final round trip: emailMode=true, passwordMode=true, captchaContainers=1. Disposable local servers and the audit browser session were stopped after verification.


## 2026-09-09 — production email delivery follow-up

Session `eventforge-email`, using the existing `jorge@pox.me` account with user
authorization. The production sign-in request delivered a real message to the
inbox (Gmail id `1a087a635294d7cc`, 19:30:05 UTC); SPF/DKIM/DMARC all passed.

1. Opened the delivered link on `https://eventforge.dev/console`; did not save its
   token in this playbook. Confirmed URL token removal and session token presence.
2. Queried `/api/auth/session` using the browser's existing session: 200, expected
   email, one membership. Reloaded and repeated: 200.
3. Retried the consumed link through `/api/auth/verify`: 400 `INVALID_TOKEN`.
4. Called `/api/auth/logout` with the request token: 200; next session request: 401.
   Cleared this audit browser's sessionStorage and closed the browser.

Email pending resolved; password/Turnstile sign-in is a separate acceptance path.
The authenticated operations UI reported “Control plane offline”; this does not
change the successful email delivery and authenticated-session results.
