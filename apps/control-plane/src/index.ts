import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { startLocalGitHubWebhook } from "./local-github.js";
import { LocalRelayController } from "./local-relay.js";
import { createTunnelProvisionerFromEnv } from "./managed-tunnel.js";
import { resolveRuntimeConfig } from "./runtime.js";
import { EventForgeStore } from "@eventforge/core";
import { createStateSyncFromEnv } from "./state-sync.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(packageRoot, "../..");
dotenv.config({ path: resolve(projectRoot, ".env") });
process.env.EVENTFORGE_CODEX_WORKDIR ??= projectRoot;

const port = Number(process.env.PORT ?? 4310);
const runtime = resolveRuntimeConfig();
const relayController = new LocalRelayController(() =>
  startLocalGitHubWebhook({
    rootDir: projectRoot,
    legacyRootDirs: [packageRoot],
    originUrl: process.env.EVENTFORGE_LOCAL_TUNNEL_ORIGIN ?? `http://127.0.0.1:${port}`,
    log: (message) => app.log.info(message),
  }),
);
const stateLog = {
  info: (object: Record<string, unknown>, message: string) =>
    console.log(JSON.stringify({ level: 30, ...object, msg: message })),
  warn: (object: Record<string, unknown>, message: string) =>
    console.warn(JSON.stringify({ level: 40, ...serializable(object), msg: message })),
  error: (object: Record<string, unknown>, message: string) =>
    console.error(JSON.stringify({ level: 50, ...serializable(object), msg: message })),
};
function serializable(object: Record<string, unknown>): Record<string, unknown> {
  const err = object.err;
  return err instanceof Error
    ? { ...object, err: { type: err.name, message: err.message } }
    : object;
}
const stateSync = createStateSyncFromEnv(process.env, stateLog);
const store = new EventForgeStore();
if (stateSync) {
  // Fails startup (systemd restarts us) rather than serving an empty, non-durable plane.
  await stateSync.hydrate(store, Number(process.env.EVENTFORGE_STATE_HYDRATE_TIMEOUT_MS ?? 60_000));
  stateSync.attach(store);
}
const app = await createApp({
  store,
  relayController,
  tunnelProvisioner: createTunnelProvisionerFromEnv(),
  stateStatus: stateSync ? () => stateSync.status() : undefined,
});
app.addHook("onClose", async () => {
  await relayController.close();
  await stateSync?.close();
});
// With a durable store, drain queued writes on shutdown (systemd sends SIGTERM).
if (stateSync)
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void Promise.resolve()
        .then(() => app.close())
        .finally(() => process.exit(0));
    });
await app.listen({ host: runtime.bindHost, port });
if (process.env.EVENTFORGE_GITHUB_LOCAL_WEBHOOK === "true") {
  try {
    await relayController.ensure("github");
  } catch (error) {
    await app.close();
    throw error;
  }
}
