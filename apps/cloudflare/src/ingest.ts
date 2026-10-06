export type DeliveryRestoreStatus =
  "accepted" | "queued" | "retrying" | "completed" | "quarantined";

export type IngestMessage = {
  deliveryId: string;
  workspaceId: string;
  installationId: string;
  provider: string;
  correlationId: string;
  destinationId?: string;
  eventId?: string;
  operation?: "process" | "replay";
  restoreStatus?: DeliveryRestoreStatus;
};
