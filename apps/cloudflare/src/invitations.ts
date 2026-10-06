import { normalizeIdentityEmail, type IdentityRole } from "./identity.js";
import { type Access, actorId, canAccessResource, forbid } from "./access.js";
import { json, problem, readJson } from "./http.js";

const INVITE_ROLES = new Set<IdentityRole>(["admin", "operator", "viewer"]);

type MembershipRow = {
  workspace_id: string;
  identity_id: string;
  role: IdentityRole;
  version: number;
  created_at: string;
  normalized_email: string;
};

type InvitationRow = {
  id: string;
  workspace_id: string;
  normalized_email: string;
  role: IdentityRole;
  inviter_identity_id: string;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

async function ensureWorkspace(env: Env, workspaceId: string): Promise<void> {
  const existing = await env.CONTROL_DB.prepare("select id from workspaces where id = ?")
    .bind(workspaceId)
    .first<{ id: string }>();
  if (existing) return;
  await env.CONTROL_DB.prepare(
    "insert into workspaces (id, name, plan, created_at) values (?, ?, 'developer', ?) on conflict(id) do nothing",
  )
    .bind(workspaceId, "Workspace", new Date().toISOString())
    .run();
}

async function audit(
  env: Env,
  access: Access,
  workspaceId: string,
  kind: string,
  subjectId: string,
  metadata: Record<string, string>,
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
      JSON.stringify(metadata),
      new Date().toISOString(),
    )
    .run();
}

export async function handleMembers(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
): Promise<Response | undefined> {
  if (rest !== "members" && rest !== "invitations") return undefined;
  const write = request.method !== "GET";
  if (!canAccessResource(access, workspaceId, "members", write ? "write" : "read"))
    return forbid("members", write ? "write" : "read");
  if (access.kind !== "session") return forbid("members", write ? "write" : "read");
  await ensureWorkspace(env, workspaceId);

  if (rest === "members" && request.method === "GET") {
    const { results } = await env.CONTROL_DB.prepare(
      "select m.workspace_id, m.identity_id, m.role, m.version, m.created_at, i.normalized_email from workspace_memberships m join identities i on i.id = m.identity_id where m.workspace_id = ? order by m.created_at",
    )
      .bind(workspaceId)
      .all<MembershipRow>();
    return json({
      items: (results ?? []).map((row) => ({
        workspaceId: row.workspace_id,
        identityId: row.identity_id,
        email: row.normalized_email,
        role: row.role,
        version: row.version,
        createdAt: row.created_at,
      })),
    });
  }

  if (rest === "invitations" && request.method === "GET") {
    const { results } = await env.CONTROL_DB.prepare(
      "select id, workspace_id, normalized_email, role, inviter_identity_id, expires_at, accepted_at, cancelled_at, created_at from workspace_invitations where workspace_id = ? order by created_at desc",
    )
      .bind(workspaceId)
      .all<InvitationRow>();
    return json({
      items: (results ?? []).map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        email: row.normalized_email,
        role: row.role,
        acceptedAt: row.accepted_at,
        createdAt: row.created_at,
      })),
    });
  }

  if (rest === "invitations" && request.method === "POST") {
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    const payload = (body.value ?? {}) as { email?: unknown; role?: unknown };
    const email =
      typeof payload.email === "string" ? normalizeIdentityEmail(payload.email) : undefined;
    const role = payload.role;
    if (!email) return problem(400, "INVALID_BODY", "A valid email is required.");
    if (typeof role !== "string" || !INVITE_ROLES.has(role as IdentityRole))
      return problem(400, "INVALID_BODY", "Invite role must be admin, operator, or viewer.");
    const now = new Date();
    const timestamp = now.toISOString();
    const existing = await env.CONTROL_DB.prepare(
      "select id, closed_at from identities where normalized_email = ?",
    )
      .bind(email)
      .first<{ id: string; closed_at: string | null }>();
    if (existing?.closed_at)
      return problem(409, "CONFLICT", "That identity is closed and cannot be invited.");
    const identityId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await env.CONTROL_DB.prepare(
        "insert into identities (id, normalized_email, created_at) values (?, ?, ?)",
      )
        .bind(identityId, email, timestamp)
        .run();
    }
    const member = await env.CONTROL_DB.prepare(
      "select identity_id from workspace_memberships where workspace_id = ? and identity_id = ?",
    )
      .bind(workspaceId, identityId)
      .first<{ identity_id: string }>();
    if (member) return problem(409, "CONFLICT", "That address already has a workspace membership.");
    const invitationId = crypto.randomUUID();
    try {
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          "insert into workspace_memberships (workspace_id, identity_id, role, version, created_at, updated_at) values (?,?,?,?,?,?)",
        ).bind(workspaceId, identityId, role, 1, timestamp, timestamp),
        env.CONTROL_DB.prepare(
          "insert into workspace_invitations (id, workspace_id, normalized_email, role, inviter_identity_id, expires_at, accepted_at, created_at) values (?,?,?,?,?,?,?,?)",
        ).bind(
          invitationId,
          workspaceId,
          email,
          role,
          access.identityId,
          new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
          timestamp,
          timestamp,
        ),
      ]);
    } catch {
      return problem(409, "CONFLICT", "That address already has a workspace membership.");
    }
    await audit(env, access, workspaceId, "invitation_created", invitationId, {
      email,
      role,
      actor: actorId(access),
    });
    return json(
      {
        id: invitationId,
        workspaceId,
        email,
        role,
        identityId,
        acceptedAt: timestamp,
      },
      201,
    );
  }

  return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
}
