import {
  type AuthenticatedCaller,
  type Membership,
  authenticate,
  hashToken,
  roleAllows,
} from "./auth.js";
import { problem } from "./http.js";
import type { IdentityRole } from "./identity.js";

export const REQUEST_TOKEN_HEADER = "x-eventforge-request-token";
export const API_KEY_PATTERN = /^efk_[a-f0-9]{48}$/;

export type ApiResource =
  "events" | "destinations" | "deliveries" | "replay" | "api_keys" | "members";
export type PermissionLevel = "none" | "read" | "write";

export type SessionAccess = {
  kind: "session";
  identityId: string;
  sessionId: string;
  memberships: Membership[];
};

export type ApiKeyPermissions = {
  events: PermissionLevel;
  destinations: PermissionLevel;
  deliveries: PermissionLevel;
  replay: PermissionLevel;
};

export type ApiKeyAccess = {
  kind: "api_key";
  keyId: string;
  workspaceId: string;
  permissions: ApiKeyPermissions;
};

export type Access = SessionAccess | ApiKeyAccess;

const SESSION_ROLE: Record<ApiResource, { read: IdentityRole; write: IdentityRole }> = {
  events: { read: "viewer", write: "operator" },
  destinations: { read: "viewer", write: "operator" },
  deliveries: { read: "viewer", write: "operator" },
  replay: { read: "operator", write: "operator" },
  api_keys: { read: "admin", write: "admin" },
  members: { read: "admin", write: "admin" },
};

export function hasPresentedCredentials(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization && /^Bearer\s+\S+/i.test(authorization)) return true;
  const token = request.headers.get(REQUEST_TOKEN_HEADER);
  const cookie = request.headers.get("cookie");
  return Boolean(token && cookie);
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export function permissionAllows(level: PermissionLevel, action: "read" | "write"): boolean {
  if (action === "read") return level === "read" || level === "write";
  return level === "write";
}

export function workspaceRole(access: Access, workspaceId: string): IdentityRole | undefined {
  if (access.kind === "api_key") return undefined;
  return access.memberships.find((membership) => membership.workspaceId === workspaceId)?.role;
}

export function ownsWorkspace(access: Access, workspaceId: string): boolean {
  if (access.kind === "api_key") return access.workspaceId === workspaceId;
  return access.memberships.some((membership) => membership.workspaceId === workspaceId);
}

export function canAccessResource(
  access: Access,
  workspaceId: string,
  resource: ApiResource,
  action: "read" | "write",
): boolean {
  if (!ownsWorkspace(access, workspaceId)) return false;
  if (access.kind === "api_key") {
    if (resource === "api_keys" || resource === "members") return false;
    return permissionAllows(access.permissions[resource], action);
  }
  const role = workspaceRole(access, workspaceId);
  if (!role) return false;
  return roleAllows(role, SESSION_ROLE[resource][action]);
}

export function forbid(resource: ApiResource, action: "read" | "write"): Response {
  return problem(
    403,
    "FORBIDDEN",
    `This caller cannot ${action} ${resource.replaceAll("_", " ")}.`,
  );
}

export function actorId(access: Access): string {
  return access.kind === "session" ? access.identityId : `api_key:${access.keyId}`;
}

function sessionAccess(caller: AuthenticatedCaller): SessionAccess {
  return {
    kind: "session",
    identityId: caller.identity.id,
    sessionId: caller.session.id,
    memberships: caller.memberships,
  };
}

export async function resolveAccess(request: Request, env: Env): Promise<Access | undefined> {
  const token = bearerToken(request);
  if (token) {
    if (!API_KEY_PATTERN.test(token)) return undefined;
    const keyHash = await hashToken(token);
    const row = await env.CONTROL_DB.prepare(
      "select id, workspace_id, events_permission, destinations_permission, deliveries_permission, replay_permission from workspace_api_keys where key_hash = ? and revoked_at is null",
    )
      .bind(keyHash)
      .first<{
        id: string;
        workspace_id: string;
        events_permission: PermissionLevel;
        destinations_permission: PermissionLevel;
        deliveries_permission: PermissionLevel;
        replay_permission: PermissionLevel;
      }>();
    if (!row) return undefined;
    await env.CONTROL_DB.prepare("update workspace_api_keys set last_used_at = ? where id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return {
      kind: "api_key",
      keyId: row.id,
      workspaceId: row.workspace_id,
      permissions: {
        events: row.events_permission,
        destinations: row.destinations_permission,
        deliveries: row.deliveries_permission,
        replay: row.replay_permission,
      },
    };
  }
  const caller = await authenticate(
    env,
    request,
    request.headers.get(REQUEST_TOKEN_HEADER) ?? undefined,
  );
  return caller ? sessionAccess(caller) : undefined;
}
