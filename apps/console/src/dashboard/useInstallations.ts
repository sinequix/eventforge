import { useCallback, useEffect, useState } from "react";
import { webhookApi, type InstallationItem } from "../api";

export function useInstallations(workspaceId: string | undefined) {
  const [installations, setInstallations] = useState<InstallationItem[]>([]);
  const [installationId, setInstallationId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(
    async (nextInstallation?: string) => {
      if (!workspaceId) return [];
      try {
        const routes = await webhookApi.installations(workspaceId);
        setInstallations(routes);
        const selected =
          nextInstallation && routes.some((row) => row.id === nextInstallation)
            ? nextInstallation
            : routes[0]?.id;
        setInstallationId(selected);
        setError(undefined);
        return routes;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Unable to load routes.");
        return [];
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { installations, installationId, setInstallationId, loading, error, reload };
}
