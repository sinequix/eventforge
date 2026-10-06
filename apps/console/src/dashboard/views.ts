export const ADMIN_VIEWS = [
  { id: "routes", label: "Routes", heading: "Routes" },
  { id: "endpoints", label: "Endpoints", heading: "Endpoints" },
  { id: "publish", label: "Send event", heading: "Send a test event" },
  { id: "deliveries", label: "Deliveries", heading: "Deliveries" },
  { id: "members", label: "Members", heading: "Members" },
  { id: "keys", label: "API keys", heading: "API keys" },
  {
    id: "operations",
    label: "Operations",
    heading: "Every autonomous action remains visible, scoped, and reviewable.",
  },
] as const;

export type AdminViewId = (typeof ADMIN_VIEWS)[number]["id"];
