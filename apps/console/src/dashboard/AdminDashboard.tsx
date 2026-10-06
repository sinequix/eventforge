import { useState } from "react";
import {
  Activity,
  GitBranch,
  KeyRound,
  RotateCcw,
  Send,
  Users,
  Webhook,
} from "lucide-react";
import App from "../App";
import { Mark } from "../Mark";
import { signOut, type Session } from "../SignInPage";
import { ApiKeysView } from "./ApiKeysView";
import { DeliveriesView } from "./DeliveriesView";
import { EndpointsView } from "./EndpointsView";
import { MembersView } from "./MembersView";
import { PublishView } from "./PublishView";
import { RoutesView } from "./RoutesView";
import { ADMIN_VIEWS, type AdminViewId } from "./views";

const ICONS: Record<AdminViewId, typeof GitBranch> = {
  routes: GitBranch,
  endpoints: Webhook,
  publish: Send,
  deliveries: RotateCcw,
  members: Users,
  keys: KeyRound,
  operations: Activity,
};

export default function AdminDashboard({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [view, setView] = useState<AdminViewId>("routes");
  const workspaceId = session.memberships[0]?.workspaceId;

  if (!workspaceId)
    return (
      <main className="console-shell min-h-screen p-8">
        <p>This account has no workspace. Join the waitlist to request access.</p>
        <a href="/waitlist">Join the waitlist</a>
      </main>
    );

  return (
    <div className="admin-shell console-shell min-h-screen">
      <div className="console-ambient pointer-events-none fixed inset-0 -z-10" />
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <Mark />
          <div>
            <p className="font-semibold tracking-tight">EventForge</p>
            <p className="muted-text text-xs">Admin</p>
          </div>
        </div>
        <nav aria-label="Sidebar" className="admin-nav">
          {ADMIN_VIEWS.map((item) => {
            const Icon = ICONS[item.id];
            const current = view === item.id;
            return (
              <button
                aria-current={current ? "page" : undefined}
                className="admin-nav-item"
                key={item.id}
                onClick={() => setView(item.id)}
                type="button"
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-foot">
          <span className="muted-text truncate text-xs">{session.identity.email}</span>
          <button
            className="quiet-button refresh-button"
            onClick={() => void signOut().then(onSignedOut)}
            type="button"
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="admin-pane">
        {view === "routes" && <RoutesView workspaceId={workspaceId} />}
        {view === "endpoints" && <EndpointsView workspaceId={workspaceId} />}
        {view === "publish" && <PublishView workspaceId={workspaceId} />}
        {view === "deliveries" && <DeliveriesView workspaceId={workspaceId} />}
        {view === "members" && <MembersView session={session} workspaceId={workspaceId} />}
        {view === "keys" && <ApiKeysView workspaceId={workspaceId} />}
        {view === "operations" && <App />}
      </div>
    </div>
  );
}
