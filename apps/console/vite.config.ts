import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const publicOrigin = process.env.EVENTFORGE_PUBLIC_ORIGIN;
const publicHost = publicOrigin ? new URL(publicOrigin).hostname : undefined;
const apiOrigin = process.env.EVENTFORGE_API_ORIGIN ?? "http://127.0.0.1:8788";

export default defineConfig(({ mode }) => ({
  base: mode === "desktop" ? "./" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "dev.eventforge.dev"],
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: true },
      "/v1": { target: apiOrigin, changeOrigin: true },
    },
    hmr: publicHost ? { host: publicHost, protocol: "wss", clientPort: 443 } : undefined,
  },
  test: {
    environment: "jsdom",
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx"],
      thresholds: { lines: 75, branches: 70 },
    },
  },
}));
