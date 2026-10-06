import type { InstallationItem } from "../api";

export function RouteSelect({
  installations,
  installationId,
  loading,
  disabled,
  onChange,
}: {
  installations: InstallationItem[];
  installationId?: string;
  loading: boolean;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="mb-4 block text-sm" htmlFor="destination-route">
      Route
      <select
        className="mt-1 w-full max-w-md rounded-lg border px-3 py-2"
        disabled={disabled}
        id="destination-route"
        onChange={(event) => onChange(event.target.value)}
        value={installationId ?? ""}
      >
        {installations.length === 0 && (
          <option value="">{loading ? "Loading routes…" : "No routes yet"}</option>
        )}
        {installations.map((row) => (
          <option key={row.id} value={row.id}>
            {row.provider} · {row.installationKey.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}
