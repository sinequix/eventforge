import { useEffect, useState } from "react";
import { RefreshCw, Webhook } from "lucide-react";
import { webhookApi, type DestinationItem } from "../api";
import { RouteSelect } from "./RouteSelect";
import { useInstallations } from "./useInstallations";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

export function EndpointsView({ workspaceId }: { workspaceId: string }) {
  const { installations, installationId, setInstallationId, loading, error: loadError, reload } =
    useInstallations(workspaceId);
  const [destinations, setDestinations] = useState<DestinationItem[]>([]);
  const [url, setUrl] = useState("https://example.com/webhooks/eventforge");
  const [revealedSecret, setRevealedSecret] = useState<string>();
  const { busy, error, notice, setError, run } = useRun();

  useEffect(() => {
    if (!installationId) {
      setDestinations([]);
      return;
    }
    let cancelled = false;
    void webhookApi
      .destinations(workspaceId, installationId)
      .then((rows) => {
        if (!cancelled) setDestinations(rows);
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Unable to load endpoints.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, installationId, setError]);

  return (
    <ViewChrome
      description="HTTPS endpoints receive Standard Webhooks POSTs for the selected route. Empty event-type filters match all events."
      error={error ?? loadError}
      eyebrow="Destinations"
      notice={notice}
      title="Endpoints"
    >
      <RouteSelect
        disabled={Boolean(busy)}
        installationId={installationId}
        installations={installations}
        loading={loading}
        onChange={(id) => {
          setInstallationId(id);
          setRevealedSecret(undefined);
        }}
      />
      <form
        className="mb-6 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!installationId) return;
          void run("destination", async () => {
            const created = await webhookApi.createDestination(workspaceId, installationId, {
              url,
            });
            setRevealedSecret(created.secret);
            setDestinations(await webhookApi.destinations(workspaceId, installationId));
          });
        }}
      >
        <label className="sr-only" htmlFor="destination-url">
          Endpoint URL
        </label>
        <input
          className="min-w-72 flex-1 rounded-lg border px-3 py-2"
          id="destination-url"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/webhooks/eventforge"
          required
          type="url"
          value={url}
        />
        <button
          className="action-button"
          disabled={!installationId || Boolean(busy)}
          type="submit"
        >
          <Webhook size={15} /> {busy === "destination" ? "Adding…" : "Add endpoint"}
        </button>
        <button
          className="quiet-button"
          disabled={Boolean(busy)}
          onClick={() => void run("reload", () => reload().then(() => undefined))}
          type="button"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </form>
      {revealedSecret && (
        <p className="notice mb-6 rounded-lg px-4 py-3 text-sm">
          Signing secret (shown once): <code>{revealedSecret}</code>
        </p>
      )}
      <div className="panel rounded-2xl p-5">
        <ul className="space-y-2 text-sm">
          {destinations.length === 0 && (
            <li className="muted-text">
              {loading ? "Loading endpoints…" : "No endpoints on this route."}
            </li>
          )}
          {destinations.map((row) => (
            <li key={row.id}>
              {row.url} · {row.status} · hint …{row.secretHint}
            </li>
          ))}
        </ul>
      </div>
    </ViewChrome>
  );
}
