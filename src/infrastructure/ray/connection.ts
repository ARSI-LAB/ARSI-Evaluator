import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseRayConfig, type RaySchedulerConfig, type RayConnectionConfig } from "../../config/ray.js";
import { join } from "node:path";
import type { WorkflowContext } from "../../core/contracts/workflow.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { startTransferReceiver } from "../transfer/https.js";
import { RayClient } from "./client.js";

type Route = "runtime" | "control" | "progress";
type Handler = (route: Route, input: unknown) => Promise<unknown>;

export function resolveRayConnectionConfig(config: RayConnectionConfig): RaySchedulerConfig {
  if (!("deployment" in config)) return config;
  if (!process.env.EVALUATOR_JOBS_ROOT) throw new TypeError("Jobs Ray connection requires the cluster coordinator environment");
  const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
  return parseRayConfig({ endpoint: "auto", pythonExecutable: "/usr/local/bin/python",
    ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    ...(config.nodes === undefined ? {} : { nodes: config.nodes }),
    collector: { host: "0.0.0.0", port: 0, publicUrl: process.env.EVALUATOR_COLLECTOR_ORIGIN ?? "https://head",
      certFile: join(security, "cert.pem"), keyFile: join(security, "key.pem"), tokenEnv: "EVALUATOR_TRANSFER_TOKEN" },
  });
}

/** One owner for a Ray driver and collector; consumers only register their request routes. */
export class RayConnection {
  constructor(readonly config: RaySchedulerConfig, readonly client: RayClient, readonly endpoint: string,
    private readonly routes: Map<string, Handler>, private readonly server: Awaited<ReturnType<typeof startTransferReceiver>>) {}
  subscribe(scope: "run" | "attempt", id: string, handler: Handler): () => void {
    const key = `${scope}:${id}`;
    if (this.routes.has(key)) throw new TypeError(`Ray control route is already registered: ${key}`);
    this.routes.set(key, handler);
    return () => { if (this.routes.get(key) === handler) this.routes.delete(key); };
  }
  async close(): Promise<void> {
    try { await this.client.close(); }
    finally { this.routes.clear(); await this.server.close(); }
  }
}

export async function openRayConnection(config: RaySchedulerConfig, context: WorkflowContext): Promise<RayConnection> {
  const token = await context.runtime.credential(config.collector.tokenEnv);
  if (!token) throw new TypeError(`Missing ${config.collector.tokenEnv}`);
  const routes = new Map<string, Handler>();
  const server = await startTransferReceiver({ token, key: await readFile(context.runtime.resolvePath(config.collector.keyFile)),
    cert: await readFile(context.runtime.resolvePath(config.collector.certFile)), host: config.collector.host, port: config.collector.port,
    async control(route, input) {
      const row = expectRecord(input, "Ray control request");
      const key = row.attemptId === undefined ? `run:${expectNonEmptyString(expectRecord(row.key, "Ray request key").runId, "run ID")}` :
        `attempt:${expectNonEmptyString(row.attemptId, "attempt ID")}`;
      const handler = routes.get(key);
      if (!handler) throw new TypeError("Ray request does not belong to an admitted run or attempt");
      return handler(route, input);
    } });
  const client = new RayClient({ endpoint: config.endpoint, pythonExecutable: /[\\/]/.test(config.pythonExecutable) ?
    context.runtime.resolvePath(config.pythonExecutable) : config.pythonExecutable,
    driverPath: fileURLToPath(new URL("python/driver.py", import.meta.url)), startupTimeoutMs: config.startupTimeoutMs,
    ...(config.nodes === undefined ? {} : { nodes: config.nodes }), ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    // Local Ray starts its own execution node and inherits that node's credentials.
    env: config.endpoint === "local" ? { ...process.env } : Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name === config.collector.tokenEnv || !/KEY|TOKEN|PASSWORD|SECRET/i.test(name))),
  });
  try {
    await client.start(context.signal);
    const endpoint = new URL(config.collector.publicUrl ?? server.url);
    if (config.collector.publicUrl && config.collector.port === 0) endpoint.port = new URL(server.url).port;
    return new RayConnection(config, client, endpoint.origin, routes, server);
  } catch (error) { await client.close(); await server.close(); throw error; }
}
