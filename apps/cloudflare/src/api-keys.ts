import { type Access, canAccessResource, forbid } from "./access.js";
import { hashToken } from "./auth.js";
import { json, problem, readJson } from "./http.js";

type PermissionLevel = "none" | "read" | "write";

type ApiKeyRow = {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  events_permission: PermissionLevel;
  destinations_permission: PermissionLevel;
  deliveries_permission: PermissionLevel;
  replay_permission: PermissionLevel;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function parsePermission(value: unknown, fallback: PermissionLevel = "none"): PermissionLevel {
  if (value === undefined || value === null) return fallback;
  if (value === "none" || value === "read" || value === "write") return value;
  throw new Error("Permission must be none, read, or write.");
}

function publicKey(row: ApiKeyRow, token?: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    prefix: row.prefix,
    permissions: {
      events: row.events_permission,
      destinations: row.destinations_permission,
      deliveries: row.deliveries_permission,
      replay: row.replay_permission,
    },
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    ...(token ? { token } : {}),
  };
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `efk_${hex}`;
}

export async function handleApiKeys(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
): Promise<Response | undefined> {
  if (rest !== "api-keys" && !rest.startsWith("api-keys/")) return undefined;
  const write = request.method !== "GET";
  if (!canAccessResource(access, workspaceId, "api_keys", write ? "write" : "read"))
    return forbid("api_keys", write ? "write" : "read");

  const workspace = await env.CONTROL_DB.prepare("select id from workspaces where id = ?")
    .bind(workspaceId)
    .first<{ id: string }>();
  if (!workspace) return problem(404, "NOT_FOUND", "Route not found.");

  if (rest === "api-keys" && request.method === "GET") {
    const { results } = await env.CONTROL_DB.prepare(
      "select id,workspace_id,name,prefix,events_permission,destinations_permission,deliveries_permission,replay_permission,last_used_at,revoked_at,created_at from workspace_api_keys where workspace_id = ? and revoked_at is null order by created_at",
    )
      .bind(workspaceId)
      .all<ApiKeyRow>();
    return json({ items: (results ?? []).map((row) => publicKey(row)) });
  }

  if (rest === "api-keys" && request.method === "POST") {
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    const payload = (body.value ?? {}) as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 80) return problem(400, "INVALID_BODY", "name is required.");
    const permissions = (payload.permissions ?? {}) as Record<string, unknown>;
    let events: PermissionLevel;
    let destinations: PermissionLevel;
    let deliveries: PermissionLevel;
    let replay: PermissionLevel;
    try {
      events = parsePermission(permissions.events);
      destinations = parsePermission(permissions.destinations);
      deliveries = parsePermission(permissions.deliveries);
      replay = parsePermission(permissions.replay);
    } catch (error) {
      return problem(
        400,
        "INVALID_BODY",
        error instanceof Error ? error.message : "Invalid permissions.",
      );
    }
    const token = generateToken();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.CONTROL_DB.prepare(
      "insert into workspace_api_keys (id,workspace_id,name,prefix,key_hash,events_permission,destinations_permission,deliveries_permission,replay_permission,created_by_identity_id,created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        workspaceId,
        name,
        token.slice(0, 12),
        await hashToken(token),
        events,
        destinations,
        deliveries,
        replay,
        access.kind === "session" ? access.identityId : null,
        now,
      )
      .run();
    if (access.kind === "session") {
      await env.CONTROL_DB.prepare(
        "insert into governance_audit_events (id,workspace_id,actor_identity_id,session_id,kind,subject_id,metadata,created_at) values (?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          workspaceId,
          access.identityId,
          access.sessionId,
          "api_key_created",
          id,
          "{}",
          now,
        )
        .run();
    }
    return json(
      publicKey(
        {
          id,
          workspace_id: workspaceId,
          name,
          prefix: token.slice(0, 12),
          events_permission: events,
          destinations_permission: destinations,
          deliveries_permission: deliveries,
          replay_permission: replay,
          last_used_at: null,
          revoked_at: null,
          created_at: now,
        },
        token,
      ),
      201,
    );
  }

  const revoke = /^api-keys\/([^/]+)$/.exec(rest);
  if (revoke && request.method === "DELETE") {
    const now = new Date().toISOString();
    const result = await env.CONTROL_DB.prepare(
      "update workspace_api_keys set revoked_at = ? where id = ? and workspace_id = ? and revoked_at is null",
    )
      .bind(now, revoke[1], workspaceId)
      .run();
    if (Number(result.meta.changes ?? 0) === 0)
      return problem(404, "NOT_FOUND", "Route not found.");
    return json({ revoked: true, id: revoke[1] });
  }

  return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
}
