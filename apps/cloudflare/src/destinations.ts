import { standardWebhooks, webhookDestinations } from "@eventforge/core";
import { type Access, canAccessResource, forbid } from "./access.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { json, problem, readJson } from "./http.js";

const { generateSigningSecret } = standardWebhooks;
const {
  parseChannelName,
  parseDestinationMode,
  parseDestinationStatus,
  parseDestinationUrl,
  parseEventType,
  parseFilterList,
  parseMaxRatePerSecond,
} = webhookDestinations;

export type DestinationRow = {
  id: string;
  workspace_id: string;
  installation_id: string;
  url: string;
  description: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  secret_hint: string;
  event_types: string;
  channels: string;
  max_rate_per_second: number;
  mode: "best_effort" | "fifo";
  status: "active" | "paused" | "disabled";
  created_at: string;
  updated_at: string;
};

type InstallationRow = {
  id: string;
  workspace_id: string;
  provider: string;
  installation_key: string;
  status: "active" | "suspended" | "deleted";
  created_at: string;
  updated_at: string;
};

function publicDestination(row: DestinationRow, secret?: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    url: row.url,
    description: row.description,
    eventTypes: JSON.parse(row.event_types) as string[],
    channels: JSON.parse(row.channels) as string[],
    maxRatePerSecond: row.max_rate_per_second,
    mode: row.mode,
    status: row.status,
    secretHint: row.secret_hint,
    ...(secret ? { secret } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicInstallation(row: InstallationRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    installationKey: row.installation_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function audit(
  env: Env,
  access: Access,
  workspaceId: string,
  kind: string,
  subjectId: string,
): Promise<void> {
  if (access.kind !== "session") return;
  await env.CONTROL_DB.prepare(
    "insert into governance_audit_events (id,workspace_id,actor_identity_id,session_id,kind,subject_id,metadata,created_at) values (?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      workspaceId,
      access.identityId,
      access.sessionId,
      kind,
      subjectId,
      "{}",
      new Date().toISOString(),
    )
    .run();
}

export async function loadInstallation(
  env: Env,
  workspaceId: string,
  installationId: string,
): Promise<InstallationRow | undefined> {
  return (
    (await env.CONTROL_DB.prepare(
      "select id, workspace_id, provider, installation_key, status, created_at, updated_at from delivery_installations where id = ? and workspace_id = ?",
    )
      .bind(installationId, workspaceId)
      .first<InstallationRow>()) ?? undefined
  );
}

export async function loadDestination(
  env: Env,
  workspaceId: string,
  destinationId: string,
): Promise<DestinationRow | undefined> {
  return (
    (await env.CONTROL_DB.prepare(
      "select id,workspace_id,installation_id,url,description,secret_ciphertext,secret_nonce,previous_secret_ciphertext,previous_secret_nonce,secret_hint,event_types,channels,max_rate_per_second,mode,status,created_at,updated_at from destination_endpoints where id = ? and workspace_id = ?",
    )
      .bind(destinationId, workspaceId)
      .first<DestinationRow>()) ?? undefined
  );
}

export async function listActiveDestinations(
  env: Env,
  workspaceId: string,
  installationId: string,
): Promise<DestinationRow[]> {
  const { results } = await env.CONTROL_DB.prepare(
    "select id,workspace_id,installation_id,url,description,secret_ciphertext,secret_nonce,previous_secret_ciphertext,previous_secret_nonce,secret_hint,event_types,channels,max_rate_per_second,mode,status,created_at,updated_at from destination_endpoints where workspace_id = ? and installation_id = ? and status = 'active'",
  )
    .bind(workspaceId, installationId)
    .all<DestinationRow>();
  return results ?? [];
}

export async function destinationSecrets(env: Env, row: DestinationRow): Promise<string[]> {
  const current = await decryptSecret(
    row.secret_ciphertext,
    row.secret_nonce,
    env.PAYLOAD_MASTER_KEY,
  );
  const secrets = [current];
  if (row.previous_secret_ciphertext && row.previous_secret_nonce) {
    secrets.push(
      await decryptSecret(
        row.previous_secret_ciphertext,
        row.previous_secret_nonce,
        env.PAYLOAD_MASTER_KEY,
      ),
    );
  }
  return secrets;
}

async function requireWorkspace(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.CONTROL_DB.prepare("select id from workspaces where id = ?")
    .bind(workspaceId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function handleInstallations(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
): Promise<Response | undefined> {
  if (rest !== "installations") return undefined;
  if (
    !canAccessResource(
      access,
      workspaceId,
      "destinations",
      request.method === "GET" ? "read" : "write",
    )
  )
    return forbid("destinations", request.method === "GET" ? "read" : "write");
  if (!(await requireWorkspace(env, workspaceId))) {
    const now = new Date().toISOString();
    await env.CONTROL_DB.prepare(
      "insert into workspaces (id, name, plan, created_at) values (?, ?, 'developer', ?) on conflict(id) do nothing",
    )
      .bind(workspaceId, "Workspace", now)
      .run();
  }

  if (rest === "installations" && request.method === "GET") {
    const { results } = await env.CONTROL_DB.prepare(
      "select id, workspace_id, provider, installation_key, status, created_at, updated_at from delivery_installations where workspace_id = ? and status != 'deleted' order by created_at",
    )
      .bind(workspaceId)
      .all<InstallationRow>();
    return json({ items: (results ?? []).map(publicInstallation) });
  }

  if (rest === "installations" && request.method === "POST") {
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    const payload = (body.value ?? {}) as { provider?: unknown; installationKey?: unknown };
    const provider = payload.provider === undefined ? "custom" : payload.provider;
    if (provider !== "custom")
      return problem(400, "INVALID_PROVIDER", "Self-serve routes must use provider custom.");
    const installationKey =
      typeof payload.installationKey === "string" && payload.installationKey.trim()
        ? payload.installationKey.trim()
        : crypto.randomUUID();
    if (installationKey.length > 128)
      return problem(400, "INVALID_BODY", "installationKey is too long.");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      await env.CONTROL_DB.prepare(
        "insert into delivery_installations (id,workspace_id,provider,installation_key,status,created_at,updated_at) values (?,?,?,?,?,?,?)",
      )
        .bind(id, workspaceId, "custom", installationKey, "active", now, now)
        .run();
    } catch {
      return problem(409, "CONFLICT", "That installation key is already in use.");
    }
    await audit(env, access, workspaceId, "installation_created", id);
    const row = await loadInstallation(env, workspaceId, id);
    return json(publicInstallation(row!), 201);
  }

  return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
}

export async function handleDestinations(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
): Promise<Response | undefined> {
  const listMatch = /^installations\/([^/]+)\/destinations$/.exec(rest);
  const itemMatch = /^destinations\/([^/]+)(?:\/(rotate-secret))?$/.exec(rest);
  if (!listMatch && !itemMatch) return undefined;

  const write = request.method !== "GET";
  if (!canAccessResource(access, workspaceId, "destinations", write ? "write" : "read"))
    return forbid("destinations", write ? "write" : "read");
  if (!(await requireWorkspace(env, workspaceId)))
    return problem(404, "NOT_FOUND", "Route not found.");

  if (listMatch && request.method === "GET") {
    const installation = await loadInstallation(env, workspaceId, listMatch[1]!);
    if (!installation) return problem(404, "NOT_FOUND", "Route not found.");
    const { results } = await env.CONTROL_DB.prepare(
      "select id,workspace_id,installation_id,url,description,secret_ciphertext,secret_nonce,previous_secret_ciphertext,previous_secret_nonce,secret_hint,event_types,channels,max_rate_per_second,mode,status,created_at,updated_at from destination_endpoints where workspace_id = ? and installation_id = ? and status != 'disabled' order by created_at",
    )
      .bind(workspaceId, installation.id)
      .all<DestinationRow>();
    return json({ items: (results ?? []).map((row) => publicDestination(row)) });
  }

  if (listMatch && request.method === "POST") {
    const installation = await loadInstallation(env, workspaceId, listMatch[1]!);
    if (!installation || installation.status === "deleted")
      return problem(404, "NOT_FOUND", "Route not found.");
    if (installation.status !== "active")
      return problem(403, "WORKSPACE_INACTIVE", "Installation is not active.");
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    const payload = (body.value ?? {}) as Record<string, unknown>;
    let url: URL;
    let eventTypes: string[];
    let channels: string[];
    let maxRate: number;
    let mode: "best_effort" | "fifo";
    try {
      url = parseDestinationUrl(typeof payload.url === "string" ? payload.url : "", {
        allowHttpLoopback: env.ENVIRONMENT !== "production",
      });
      eventTypes = parseFilterList(payload.eventTypes, parseEventType);
      channels = parseFilterList(payload.channels, parseChannelName);
      maxRate = parseMaxRatePerSecond(payload.maxRatePerSecond);
      mode = parseDestinationMode(payload.mode);
    } catch (error) {
      return problem(
        400,
        "INVALID_BODY",
        error instanceof Error ? error.message : "Invalid destination.",
      );
    }
    const description =
      typeof payload.description === "string" ? payload.description.trim().slice(0, 200) : "";
    const secret = generateSigningSecret();
    const encrypted = await encryptSecret(secret, env.PAYLOAD_MASTER_KEY);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await env.CONTROL_DB.prepare(
      "insert into destination_endpoints (id,workspace_id,installation_id,url,description,secret_ciphertext,secret_nonce,secret_hint,event_types,channels,max_rate_per_second,mode,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        workspaceId,
        installation.id,
        url.toString(),
        description,
        encrypted.ciphertext,
        encrypted.nonce,
        secret.slice(-4),
        JSON.stringify(eventTypes),
        JSON.stringify(channels),
        maxRate,
        mode,
        "active",
        now,
        now,
      )
      .run();
    await audit(env, access, workspaceId, "destination_created", id);
    const row = await loadDestination(env, workspaceId, id);
    return json(publicDestination(row!, secret), 201);
  }

  if (itemMatch && request.method === "GET" && !itemMatch[2]) {
    const row = await loadDestination(env, workspaceId, itemMatch[1]!);
    if (!row || row.status === "disabled") return problem(404, "NOT_FOUND", "Route not found.");
    return json(publicDestination(row));
  }

  if (itemMatch && request.method === "PATCH" && !itemMatch[2]) {
    const row = await loadDestination(env, workspaceId, itemMatch[1]!);
    if (!row || row.status === "disabled") return problem(404, "NOT_FOUND", "Route not found.");
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    const payload = (body.value ?? {}) as Record<string, unknown>;
    try {
      const url =
        payload.url === undefined
          ? row.url
          : parseDestinationUrl(String(payload.url), {
              allowHttpLoopback: env.ENVIRONMENT !== "production",
            }).toString();
      const eventTypes =
        payload.eventTypes === undefined
          ? row.event_types
          : JSON.stringify(parseFilterList(payload.eventTypes, parseEventType));
      const channels =
        payload.channels === undefined
          ? row.channels
          : JSON.stringify(parseFilterList(payload.channels, parseChannelName));
      const maxRate =
        payload.maxRatePerSecond === undefined
          ? row.max_rate_per_second
          : parseMaxRatePerSecond(payload.maxRatePerSecond);
      const mode = payload.mode === undefined ? row.mode : parseDestinationMode(payload.mode);
      const status =
        payload.status === undefined ? row.status : parseDestinationStatus(payload.status);
      const description =
        payload.description === undefined
          ? row.description
          : typeof payload.description === "string"
            ? payload.description.trim().slice(0, 200)
            : row.description;
      const now = new Date().toISOString();
      await env.CONTROL_DB.prepare(
        "update destination_endpoints set url=?, description=?, event_types=?, channels=?, max_rate_per_second=?, mode=?, status=?, updated_at=? where id=? and workspace_id=?",
      )
        .bind(
          url,
          description,
          eventTypes,
          channels,
          maxRate,
          mode,
          status,
          now,
          row.id,
          workspaceId,
        )
        .run();
    } catch (error) {
      return problem(
        400,
        "INVALID_BODY",
        error instanceof Error ? error.message : "Invalid destination.",
      );
    }
    await audit(env, access, workspaceId, "destination_updated", row.id);
    return json(publicDestination((await loadDestination(env, workspaceId, row.id))!));
  }

  if (itemMatch && request.method === "DELETE" && !itemMatch[2]) {
    const row = await loadDestination(env, workspaceId, itemMatch[1]!);
    if (!row || row.status === "disabled") return problem(404, "NOT_FOUND", "Route not found.");
    const now = new Date().toISOString();
    await env.CONTROL_DB.prepare(
      "update destination_endpoints set status='disabled', updated_at=? where id=? and workspace_id=?",
    )
      .bind(now, row.id, workspaceId)
      .run();
    await audit(env, access, workspaceId, "destination_disabled", row.id);
    return json({ disabled: true, id: row.id });
  }

  if (itemMatch?.[2] === "rotate-secret" && request.method === "POST") {
    const row = await loadDestination(env, workspaceId, itemMatch[1]!);
    if (!row || row.status === "disabled") return problem(404, "NOT_FOUND", "Route not found.");
    const secret = generateSigningSecret();
    const encrypted = await encryptSecret(secret, env.PAYLOAD_MASTER_KEY);
    const now = new Date().toISOString();
    await env.CONTROL_DB.prepare(
      "update destination_endpoints set previous_secret_ciphertext=secret_ciphertext, previous_secret_nonce=secret_nonce, secret_ciphertext=?, secret_nonce=?, secret_hint=?, updated_at=? where id=? and workspace_id=?",
    )
      .bind(encrypted.ciphertext, encrypted.nonce, secret.slice(-4), now, row.id, workspaceId)
      .run();
    await audit(env, access, workspaceId, "destination_secret_rotated", row.id);
    const updated = await loadDestination(env, workspaceId, row.id);
    return json(publicDestination(updated!, secret));
  }

  return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
}
