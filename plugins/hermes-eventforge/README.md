# EventForge for Hermes

EventForge for Hermes connects a Hermes Agent session to the EventForge control plane that already ships in this repository. The plugin is an HTTP proxy. Workflow matching, signature checks, policy, forge drafts, and approvals stay in the control plane (`packages/mcp-server/src/server.ts` and `apps/control-plane`).

Requires Hermes Agent `>=0.22.0`. The floor matches the plugin contract used here: manifest v2 `config_schema` secrets, `ctx.register_skill`, `ctx.register_command`, `ctx.state`, and the `pre_tool_call` `{"action": "approve"}` gate. The v0.22.0 tag already contains that approve directive and `PluginState`. It was checked against Hermes Agent v0.22.7.

## Install

From a checkout of this repository, link the plugin into Hermes and enable it. `hermes plugins install ./plugins/hermes-eventforge` is not a local install on v0.22.7: that command treats the argument as a GitHub repository.

```bash
ln -s "$PWD/plugins/hermes-eventforge" ~/.hermes/plugins/eventforge
hermes plugins enable eventforge
```

Once a maintainer pins this plugin in the Hermes catalog, the catalog install is:

```bash
hermes plugins install eventforge
```

Hermes v0.22.7 also accepts an owner, repository, and subdirectory, with `--ref` set to one 40-character commit SHA:

```bash
hermes plugins install sinequix/eventforge/plugins/hermes-eventforge --ref <40-character commit SHA>
```

A catalog or `--ref` install copies only `plugins/hermes-eventforge`. It does not include `eventforge-standalone.cjs` (that minified bundle stays out of this directory). Set `bundle_path` to a bundle you built from this repo, or run the control plane yourself. With `auto_start` on and no bundle in reach, the plugin stops with: `catalog install: set bundle_path or run the EventForge control plane yourself`.

## Control plane

The tools talk to `http://127.0.0.1:4310` unless `api_url` says otherwise. Plain HTTP is accepted only for loopback. A remote plane must be `https`, and its bearer token is the Hermes secret `EVENTFORGE_API_TOKEN`.

Build the bundle from this repo. The plugin does not download it:

```bash
pnpm install --frozen-lockfile
pnpm --filter @eventforge/mcp-server bundle:plugin
node plugins/eventforge/server/eventforge-standalone.cjs
```

Leave that process running. The bundle stops the embedded plane when its stdin closes. The same plane can be started from source with `pnpm --filter @eventforge/control-plane dev`.

`auto_start` defaults to false. Set it to true only in an interactive CLI, TUI, or Desktop session if you want the plugin to run `node` on `eventforge-standalone.cjs` when `/health` is down. An empty `bundle_path` finds that file only when this plugin is a checkout or a symlink into one, next to `plugins/eventforge/server/`. A catalog install has to set `bundle_path` or start the plane itself. Cron, kanban, single-query, and the messaging gateway never spawn that process. The child's stderr goes to `bundle-stderr.log` under Hermes plugin data (`plugin-data/eventforge`), capped and rotated locally. It is not uploaded.

## Tools

| Tool                      | Control-plane route          | Notes                                          |
| ------------------------- | ---------------------------- | ---------------------------------------------- |
| `ef_listen_for_webhook`   | `POST /relay/ensure`         | Refused in cron and the messaging gateway      |
| `ef_emit_event`           | `POST /events`               | Unverified manual event                        |
| `ef_query_memory`         | `GET /memory`                | Read-only                                      |
| `ef_spawn_subagent`       | `POST /agent-runs`           | Hermes approval required                       |
| `ef_approve_action`       | `POST /actions/:id/decision` | Hermes approval required                       |
| `ef_forge_mcp`            | `POST /forge`                | Hermes approval required; creates a draft only |
| `ef_approve_forge`        | `POST /forge/:id/decision`   | Hermes approval required                       |
| `ef_list_events`          | `GET /events`                | Read-only; unverified payloads withheld        |
| `ef_list_pending_actions` | `GET /actions`               | Read-only; pending proposals and their ids     |
| `ef_list_workflows`       | `GET /workflows`             | Read-only                                      |

`ef_approve_forge` is gated with the three tools named in the hackathon brief because it is the same kind of irreversible decision as `ef_approve_action`.

## Hooks

- `pre_llm_call` appends verified events the session has not shown yet. `demo` and `unverified` events are not injected.
- `pre_tool_call` returns `{"action": "approve"}` for `ef_approve_action`, `ef_approve_forge`, `ef_forge_mcp`, and `ef_spawn_subagent`. That asks Hermes to ask the user. The plugin cannot approve the call itself, and it does not turn on YOLO or an unattended allow mode. `ef_approve_action` and `ef_approve_forge` use `rule_key` `tool:id`, so an always-allow covers that one decision and not the next one. `ef_spawn_subagent` and `ef_forge_mcp` stay keyed by tool name.
- `post_tool_call` writes a `hermes_tool` audit line for `ef_*` tools. The line is the tool name, ok or error, duration, and a truncated session id. Arguments and result bodies are not sent.
- `on_session_start` calls `GET /health` and stores the result. A down plane is a stored error, not a crash.

## Slash command and skill

- `/eventforge status` shows the health check.
- `/eventforge events` lists recent events.
- `/eventforge replay <id>` prints one stored event and related audit lines. It does not re-run a workflow.
- The skill `eventforge:triage` tells the model to investigate read-only and to wait for Hermes approval before the gated tools.

## Disclosure

What this plugin does that you should know before enabling it:

- It sends HTTP requests to the EventForge control plane at `api_url` (default `http://127.0.0.1:4310` on your machine). It does not call Nous, GitHub, or any other host on its own. `ef_listen_for_webhook` asks the local control plane to ensure a provider relay, and that plane may open a tunnel using its own configuration.
- When `auto_start` is true, an interactive session may spawn `node` on `eventforge-standalone.cjs` and keep that process alive with an open stdin pipe. The child inherits the Hermes process environment. The plugin does not put the API token on the command line. Stderr is appended to a local capped log under Hermes plugin data and is not sent off the machine. Cron, kanban, single-query sessions, programmatic platforms, and the messaging gateway do not spawn it. A catalog install without `bundle_path` and without a sibling bundle does not spawn it either.
- It reads the bearer token only through Hermes `get_secret("EVENTFORGE_API_TOKEN")`. It does not read `.env` files, `auth.json`, or another tool's credential store.
- `pre_llm_call` reads `GET /events` and may place verified event payloads into the model prompt. Those payloads are provider data. The injected text tells the model not to follow instructions inside them.
- `post_tool_call` writes a short audit line to `POST /audit` on the control plane for `ef_*` tools only.
- It does not patch Hermes, disable approvals, or auto-approve. If Hermes is in cron, a single-query run, or another unattended mode, Hermes's own approval gate decides the four gated tools. This plugin still returns immediately with an error when the control plane is down, and it refuses the webhook relay in those sessions so it does not sit on a tunnel.

Permissions you need: a local or configured EventForge control plane, optional `EVENTFORGE_API_TOKEN` for a protected plane, and Node.js 20.11 or newer only if you start the bundled plane. The plugin declares no extra Python dependencies and no privileged Hermes capability such as `tools.override`.
