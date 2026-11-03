/** Optional, ephemeral component observations. Never part of task results or trajectories. */
export type ComponentActivity = {
  message?: string;
  lines?: readonly string[];
  /** False for capability/status notifications that are not evidence of work. */
  activity?: boolean;
  /** Optional component-owned substep identity, scoped under the caller's operation. */
  operationId?: string;
  status?: "started" | "updated" | "completed" | "failed" | "cancelled";
};

export type ActivityListener = (event: ComponentActivity) => void;
