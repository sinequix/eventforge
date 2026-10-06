import { useEffect, useState } from "react";
import { webhookApi, type ApiKeyItem, type ApiKeyPermission } from "../api";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

const LEVELS: ApiKeyPermission[] = ["none", "read", "write"];

export function ApiKeysView({ workspaceId }: { workspaceId: string }) {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("publisher");
  const [events, setEvents] = useState<ApiKeyPermission>("write");
  const [destinations, setDestinations] = useState<ApiKeyPermission>("write");
  const [deliveries, setDeliveries] = useState<ApiKeyPermission>("read");
  const [replay, setReplay] = useState<ApiKeyPermission>("none");
  const [revealedToken, setRevealedToken] = useState<string>();
  const { busy, error, notice, setError, run } = useRun();

  const reload = async () => {
    setKeys(await webhookApi.apiKeys(workspaceId));
  };

  useEffect(() => {
    let cancelled = false;
    void webhookApi
      .apiKeys(workspaceId)
      .then((rows) => {
        if (!cancelled) setKeys(rows);
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Unable to load API keys.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, setError]);

  return (
    <ViewChrome
      description="Keys authenticate /v1 calls. The full token is shown once at creation. lastUsedAt is empty until the key is used."
      error={error}
      eyebrow="Access"
      notice={notice}
      title="API keys"
    >
      <form
        className="panel mb-8 rounded-2xl p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void run("create", async () => {
            const created = await webhookApi.createApiKey(workspaceId, {
              name,
              permissions: { events, destinations, deliveries, replay },
            });
            setRevealedToken(created.token);
            setName("publisher");
            await reload();
          });
        }}
      >
        <label className="mb-3 block text-sm" htmlFor="api-key-name">
          Name
          <input
            className="mt-1 w-full max-w-md rounded-lg border px-3 py-2"
            id="api-key-name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PermissionSelect id="perm-events" label="Events" onChange={setEvents} value={events} />
          <PermissionSelect
            id="perm-destinations"
            label="Destinations"
            onChange={setDestinations}
            value={destinations}
          />
          <PermissionSelect
            id="perm-deliveries"
            label="Deliveries"
            onChange={setDeliveries}
            value={deliveries}
          />
          <PermissionSelect id="perm-replay" label="Replay" onChange={setReplay} value={replay} />
        </div>
        <button className="action-button" disabled={Boolean(busy)} type="submit">
          {busy === "create" ? "Creating…" : "Create key"}
        </button>
      </form>
      {revealedToken && (
        <p className="notice mb-6 rounded-lg px-4 py-3 text-sm">
          API token (shown once): <code>{revealedToken}</code>
        </p>
      )}
      <div className="panel rounded-2xl p-5">
        <ul className="space-y-3 text-sm">
          {keys.length === 0 && (
            <li className="muted-text">{loading ? "Loading API keys…" : "No API keys yet."}</li>
          )}
          {keys.map((row) => (
            <li className="flex flex-wrap items-center justify-between gap-3" key={row.id}>
              <span>
                {row.name} · {row.prefix}… · {row.lastUsedAt ? `last used ${row.lastUsedAt}` : "Never used"}
              </span>
              <button
                className="quiet-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run(`revoke:${row.id}`, async () => {
                    await webhookApi.revokeApiKey(workspaceId, row.id);
                    setRevealedToken(undefined);
                    await reload();
                  })
                }
                type="button"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </div>
    </ViewChrome>
  );
}

function PermissionSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: ApiKeyPermission;
  onChange: (value: ApiKeyPermission) => void;
}) {
  return (
    <label className="block text-sm" htmlFor={id}>
      {label}
      <select
        className="mt-1 w-full rounded-lg border px-3 py-2"
        id={id}
        onChange={(event) => onChange(event.target.value as ApiKeyPermission)}
        value={value}
      >
        {LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </label>
  );
}
