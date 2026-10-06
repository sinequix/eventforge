import { useEffect, useState } from "react";
import { webhookApi, type MemberItem } from "../api";
import type { Session } from "../SignInPage";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

function canInvite(session: Session): boolean {
  return session.memberships.some(
    (membership) => membership.role === "owner" || membership.role === "admin",
  );
}

export function MembersView({ workspaceId, session }: { workspaceId: string; session: Session }) {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "operator" | "viewer">("operator");
  const { busy, error, notice, setError, run } = useRun();
  const inviting = canInvite(session);

  useEffect(() => {
    if (!inviting) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void webhookApi
      .members(workspaceId)
      .then((rows) => {
        if (!cancelled) setMembers(rows);
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Unable to load members.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, inviting, setError]);

  return (
    <ViewChrome
      description="Invitations create memberships out of band. There is no self-serve signup."
      error={error}
      eyebrow="Access"
      notice={notice}
      title="Members"
    >
      <div className="panel rounded-2xl p-5">
        <ul className="mb-4 space-y-2 text-sm">
          {members.length === 0 && (
            <li className="muted-text">
              {loading
                ? "Loading members…"
                : inviting
                  ? "No members listed yet."
                  : "Member management requires an admin or owner role."}
            </li>
          )}
          {members.map((row) => (
            <li key={row.identityId}>
              {row.email} · {row.role}
            </li>
          ))}
        </ul>
        {inviting && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run("invite", async () => {
                await webhookApi.invite(workspaceId, { email: inviteEmail, role: inviteRole });
                setInviteEmail("");
                setMembers(await webhookApi.members(workspaceId));
              });
            }}
          >
            <label className="sr-only" htmlFor="invite-email">
              Member email
            </label>
            <input
              className="min-w-64 flex-1 rounded-lg border px-3 py-2"
              id="invite-email"
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="ops@example.com"
              required
              type="email"
              value={inviteEmail}
            />
            <label className="sr-only" htmlFor="invite-role">
              Role
            </label>
            <select
              className="rounded-lg border px-3 py-2"
              id="invite-role"
              onChange={(event) =>
                setInviteRole(event.target.value as "admin" | "operator" | "viewer")
              }
              value={inviteRole}
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
            <button className="action-button" disabled={Boolean(busy)} type="submit">
              Invite
            </button>
          </form>
        )}
      </div>
    </ViewChrome>
  );
}
