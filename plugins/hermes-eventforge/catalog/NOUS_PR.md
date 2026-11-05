# Add EventForge to the plugin catalog

Replace `sha: PLACEHOLDER_40` in `plugin-catalog/eventforge.yaml` with the 40-character merge commit of sinequix/eventforge that contains `plugins/hermes-eventforge` at version 0.1.0. Do not open this pull request until that commit exists. This file is the description to paste on that pull request. It is not itself a pull request.

## Summary

EventForge for Hermes proxies the local EventForge control plane into Hermes Agent. The control plane and its nine MCP routes stay in sinequix/eventforge. The plugin does not reimplement them and does not download code at runtime.

Surfaces:

- Tools: `ef_listen_for_webhook`, `ef_emit_event`, `ef_query_memory`, `ef_spawn_subagent`, `ef_approve_action`, `ef_forge_mcp`, `ef_approve_forge`, `ef_list_events`, `ef_list_workflows`.
- Hooks: `pre_llm_call`, `pre_tool_call`, `post_tool_call`, `on_session_start`.
- Slash command: `/eventforge status|events|replay <id>`.
- Skill: `eventforge:triage`.

`requires_hermes` is `>=0.22.0` in both `plugin.yaml` and this entry. `version` is `"0.1.0"`. `subdir` is `plugins/hermes-eventforge`.

## Disclosure

- Network: HTTP to the configured EventForge control plane, default `http://127.0.0.1:4310`. No calls to Nous or other third parties from the plugin itself. `ef_listen_for_webhook` asks the local plane to ensure a provider relay; that plane may open a tunnel with its own configuration.
- Process: `auto_start` is off by default. When the user turns it on, an interactive checkout or symlink may spawn `node` on the repository bundle `plugins/eventforge/server/eventforge-standalone.cjs` (built from this repo's TypeScript, not downloaded, and not copied into `plugins/hermes-eventforge`). A catalog install has no sibling bundle. Leave `bundle_path` empty only for a checkout or symlink; otherwise set `bundle_path` to that built file or run the control plane yourself. With neither, `auto_start` fails with `catalog install: set bundle_path or run the EventForge control plane yourself`. Cron, kanban, single-query, and the messaging gateway never spawn it. The child inherits the process environment. The API token is not placed on the command line. Stderr is written to a capped local file under Hermes `plugin-data/eventforge` and is not uploaded.
- Secrets: bearer token only via `agent.secret_scope.get_secret("EVENTFORGE_API_TOKEN")`. No `.env`, `auth.json`, or other credential-store reads.
- Prompt data: `pre_llm_call` reads verified events and may append their payloads to the user turn, labeled untrusted.
- Audit: `post_tool_call` posts a short `hermes_tool` line (tool name, ok or error, duration, truncated session id) to the local plane. Tool arguments and result bodies are not included.
- Approvals: `pre_tool_call` returns Hermes's `{"action": "approve"}` directive for `ef_approve_action`, `ef_approve_forge`, `ef_forge_mcp`, and `ef_spawn_subagent`. The plugin does not auto-approve, disable guards, or spawn a YOLO or non-interactive Hermes child. Unattended Hermes policy still decides those tools. A down control plane returns an error immediately.

No screenshots: the plugin has no UI of its own.

## Validation

Run from a checkout at the pinned commit:

```bash
hermes plugins doctor plugins/hermes-eventforge --ci
hermes plugins validate plugins/hermes-eventforge --install-deps
python3 -m unittest discover -s plugins/hermes-eventforge/tests -v
```
