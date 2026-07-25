import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ConsoleGate from "./ConsoleGate";
import FeaturesPage from "./FeaturesPage";
import LandingPage from "./LandingPage";
import WaitlistPage from "./WaitlistPage";
import { initializeAnalytics } from "./analytics";
import "./styles.css";
import { applyTheme, getInitialTheme } from "./theme";

type WebMcpContext = {
  registerTool: (tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: () => Promise<Record<string, string>>;
    annotations?: { readOnlyHint?: boolean };
  }) => void;
};

function registerWebMcpTool() {
  const modelContext = (navigator as Navigator & { modelContext?: WebMcpContext }).modelContext;
  if (!modelContext) return;

  modelContext.registerTool({
    name: "eventforge_get_started",
    description: "Return the public EventForge installation and operating-surface links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({
      install:
        "codex mcp add eventforge -- npx -y --package github:tebayoso/eventforge eventforge-mcp",
      docs: "https://github.com/tebayoso/eventforge/blob/main/workfiles/CONFIGURATION.md",
      repository: "https://github.com/tebayoso/eventforge",
    }),
    annotations: { readOnlyHint: true },
  });
}

const isConsoleRoute =
  Boolean(window.eventforgeDesktop) ||
  window.location.pathname === "/console" ||
  window.location.pathname.startsWith("/console/");
const isWaitlistRoute = window.location.pathname === "/waitlist";
const isFeaturesRoute = window.location.pathname === "/features";
applyTheme(getInitialTheme());
void initializeAnalytics();
registerWebMcpTool();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isConsoleRoute ? (
      <ConsoleGate />
    ) : isWaitlistRoute ? (
      <WaitlistPage />
    ) : isFeaturesRoute ? (
      <FeaturesPage />
    ) : (
      <LandingPage />
    )}
  </StrictMode>,
);
