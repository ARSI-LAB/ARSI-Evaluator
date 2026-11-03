/** No model credentials or evaluation state are needed for image maintenance. */
export type ImageCleanupRequest = { all: boolean; execute: boolean; configFingerprint?: string };
export type ImageCleanupItem = {
  reference: string;
  imageId: string;
  status: "candidate" | "deleted" | "retained" | "skipped" | "failed";
  reason: string;
};
export type ImageCleanupNode = { nodeId: string; daemonId: string; inventoryId?: string; items: ImageCleanupItem[]; error?: string };
export type ImageCleanupSummary = { preview: boolean; nodes: ImageCleanupNode[] };
