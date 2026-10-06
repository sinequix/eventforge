import { useState } from "react";
import { Send } from "lucide-react";
import { webhookApi } from "../api";
import { RouteSelect } from "./RouteSelect";
import { useInstallations } from "./useInstallations";
import { useRun } from "./useRun";
import { ViewChrome } from "./ViewChrome";

export function PublishView({ workspaceId }: { workspaceId: string }) {
  const { installations, installationId, setInstallationId, loading, error: loadError } =
    useInstallations(workspaceId);
  const [eventType, setEventType] = useState("invoice.paid");
  const [payloadText, setPayloadText] = useState('{\n  "id": "evt_test"\n}');
  const { busy, error, notice, setNotice, run } = useRun();

  return (
    <ViewChrome
      description="Publishes through the hosted API. Destinations receive an outbound POST only after durable delivery is enabled."
      error={error ?? loadError}
      eyebrow="Events"
      notice={notice}
      title="Send a test event"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!installationId) return;
          void run("publish", async () => {
            let payload: Record<string, unknown>;
            try {
              const parsed: unknown = JSON.parse(payloadText);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("payload must be a JSON object.");
              payload = parsed as Record<string, unknown>;
            } catch (caught) {
              throw caught instanceof Error ? caught : new Error("payload must be valid JSON.");
            }
            const published = await webhookApi.publish(workspaceId, {
              installationId,
              eventType,
              payload,
            });
            setNotice(
              published.matchedDestinationCount === 0
                ? `Stored event ${published.eventId} with no matching endpoints.`
                : `Accepted event ${published.eventId} for ${published.matchedDestinationCount} endpoint${published.matchedDestinationCount === 1 ? "" : "s"}.`,
            );
          });
        }}
      >
        <RouteSelect
          disabled={Boolean(busy)}
          installationId={installationId}
          installations={installations}
          loading={loading}
          onChange={setInstallationId}
        />
        <label className="mb-3 block text-sm" htmlFor="publish-event-type">
          Event type
          <input
            className="mt-1 w-full max-w-md rounded-lg border px-3 py-2"
            id="publish-event-type"
            onChange={(event) => setEventType(event.target.value)}
            required
            value={eventType}
          />
        </label>
        <label className="mb-4 block text-sm" htmlFor="publish-payload">
          Payload
          <textarea
            className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs"
            id="publish-payload"
            onChange={(event) => setPayloadText(event.target.value)}
            required
            rows={6}
            value={payloadText}
          />
        </label>
        <button
          className="action-button"
          disabled={!installationId || Boolean(busy)}
          type="submit"
        >
          <Send size={15} /> {busy === "publish" ? "Sending…" : "Send event"}
        </button>
      </form>
    </ViewChrome>
  );
}
