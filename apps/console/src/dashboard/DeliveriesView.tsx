import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { webhookApi, type DeliveryLogItem } from "../api";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

export function DeliveriesView({ workspaceId }: { workspaceId: string }) {
  const [deliveries, setDeliveries] = useState<DeliveryLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [replayTarget, setReplayTarget] = useState<DeliveryLogItem>();
  const [replayReason, setReplayReason] = useState("");
  const { busy, error, notice, setError, run } = useRun();

  const reload = async () => {
    const rows = await webhookApi.deliveries(workspaceId);
    setDeliveries(rows);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await webhookApi.deliveries(workspaceId);
        if (!cancelled) setDeliveries(rows);
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Unable to load deliveries.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, setError]);

  return (
    <ViewChrome
      description="Replay creates a linked new attempt. It does not overwrite the original delivery. Record why this is being replayed — the reason is audited. Replay stays gated until durable delivery is enabled."
      error={error}
      eyebrow="Logs"
      notice={notice}
      title="Deliveries"
    >
      <button
        className="quiet-button mb-6"
        disabled={Boolean(busy)}
        onClick={() => void run("reload", () => reload())}
        type="button"
      >
        <RefreshCw size={15} /> Refresh
      </button>
      <div className="panel mb-8 rounded-2xl p-5">
        <ul className="space-y-2 text-sm">
          {deliveries.length === 0 && (
            <li className="muted-text">
              {loading
                ? "Loading deliveries…"
                : "No deliveries yet. Publish stays stored until delivery is enabled."}
            </li>
          )}
          {deliveries.map((row) => (
            <li className="flex flex-wrap items-center gap-3" key={row.id}>
              <span>
                {row.status}
                {row.safeReason ? ` (${row.safeReason})` : ""}
                {row.eventId ? ` · ${row.eventId}` : ""} · {row.attemptsCount} attempts
              </span>
              <button
                className="quiet-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  setReplayTarget(row);
                  setReplayReason("");
                }}
                type="button"
              >
                <RotateCcw size={14} /> Replay
              </button>
            </li>
          ))}
        </ul>
      </div>
      {replayTarget && (
        <form
          className="panel rounded-2xl p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const target = replayTarget;
            void run(`replay:${target.id}`, async () => {
              await webhookApi.replay(workspaceId, target.id, replayReason);
              setReplayTarget(undefined);
              setReplayReason("");
              await reload();
            });
          }}
        >
          <h3 className="panel-title mb-2 font-semibold">Replay delivery</h3>
          <label className="mb-3 block text-sm" htmlFor="replay-reason">
            Reason
            <textarea
              className="mt-1 w-full rounded-lg border px-3 py-2"
              id="replay-reason"
              minLength={8}
              onChange={(event) => setReplayReason(event.target.value)}
              required
              rows={3}
              value={replayReason}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="action-button" disabled={Boolean(busy)} type="submit">
              Confirm replay
            </button>
            <button
              className="quiet-button"
              onClick={() => setReplayTarget(undefined)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </ViewChrome>
  );
}
