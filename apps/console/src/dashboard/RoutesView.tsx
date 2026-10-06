import { Plus, RefreshCw } from "lucide-react";
import { webhookApi } from "../api";
import { useInstallations } from "./useInstallations";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

export function RoutesView({ workspaceId }: { workspaceId: string }) {
  const { installations, loading, error: loadError, reload } = useInstallations(workspaceId);
  const { busy, error, notice, run } = useRun();

  return (
    <ViewChrome
      description="A route is an installation. Endpoints and test events attach to one route."
      error={error ?? loadError}
      eyebrow="Workspace"
      notice={notice}
      title="Routes"
    >
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          className="action-button"
          disabled={Boolean(busy)}
          onClick={() =>
            void run("route", async () => {
              const created = await webhookApi.createInstallation(workspaceId);
              await reload(created.id);
            })
          }
          type="button"
        >
          <Plus size={15} /> {busy === "route" ? "Creating…" : "New route"}
        </button>
        <button
          className="quiet-button"
          disabled={Boolean(busy)}
          onClick={() => void run("reload", () => reload().then(() => undefined))}
          type="button"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      <div className="panel rounded-2xl p-5">
        <ul className="space-y-2 text-sm">
          {installations.length === 0 && (
            <li className="muted-text">{loading ? "Loading routes…" : "No routes yet."}</li>
          )}
          {installations.map((row) => (
            <li key={row.id}>
              {row.provider} · {row.installationKey} · {row.status}
            </li>
          ))}
        </ul>
      </div>
    </ViewChrome>
  );
}
