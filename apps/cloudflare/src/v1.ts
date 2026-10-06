import { hasPresentedCredentials, ownsWorkspace, resolveAccess } from "./access.js";
import { handleApiKeys } from "./api-keys.js";
import { handleDestinations, handleInstallations } from "./destinations.js";
import { handleLogs } from "./deliveries.js";
import { problem } from "./http.js";
import { handleMembers } from "./invitations.js";
import { handlePublish } from "./publish.js";

export async function handleV1(request: Request, env: Env): Promise<Response> {
  if (!hasPresentedCredentials(request)) {
    return problem(
      503,
      "AUTH_GATED",
      "Authentication and tenant repositories are not enabled yet.",
    );
  }
  const url = new URL(request.url);
  const match = /^\/v1\/workspaces\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return problem(404, "NOT_FOUND", "Route not found.");
  const workspaceId = decodeURIComponent(match[1]!);
  const rest = match[2] ?? "";
  const access = await resolveAccess(request, env);
  if (!access) return problem(401, "UNAUTHENTICATED", "No valid session or API key.");
  if (!ownsWorkspace(access, workspaceId)) return problem(404, "NOT_FOUND", "Route not found.");

  const destination = await handleDestinations(request, env, access, workspaceId, rest);
  if (destination) return destination;
  const installations = await handleInstallations(request, env, access, workspaceId, rest);
  if (installations) return installations;
  const published = await handlePublish(request, env, access, workspaceId, rest);
  if (published) return published;
  const logs = await handleLogs(request, env, access, workspaceId, rest, url);
  if (logs) return logs;
  const keys = await handleApiKeys(request, env, access, workspaceId, rest);
  if (keys) return keys;
  const members = await handleMembers(request, env, access, workspaceId, rest);
  if (members) return members;
  return problem(404, "NOT_FOUND", "Route not found.");
}
