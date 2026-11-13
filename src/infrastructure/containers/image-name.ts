import { createHash } from "node:crypto";
import type { ContainerPlatform, EnvironmentPreparationContext, EnvironmentSpec } from "../../core/contracts/environment.js";

export type DockerImageScope = EnvironmentPreparationContext & { service?: string };

export function dockerImageReference(platform: ContainerPlatform, purpose: string, scope?: EnvironmentSpec["imageScope"]): string {
  const dataset = scope?.dataset.replace(/^terminal-bench@4\.0(?:\.0)?$/u, "terminalbench4.0") ?? "base";
  const parts = (scope?.taskPath?.split("/") ?? []).map(part => component(part, 32, "task"));
  const repository = ["ember-evaluator", dataset.toLowerCase().replace(/[^a-z0-9.]+/gu, "-").replace(/[.-]{2,}/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "").slice(0, 64).replace(/[.-]+$/u, "") || "task"];
  for (const part of parts) {
    if (repository.join("/").length + part.length + 1 > 250) break;
    repository.push(part);
  }
  return `${repository.join("/")}:${platform.replace("/", "-")}-${component(purpose, 108, "runtime")}`;
}

function component(value: string, limit: number, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, limit).replace(/^-+|-+$/gu, "") || fallback;
}

/** Reuse content across tasks while keeping phases and service names distinct. */
export function dockerImageName(kind: string, contentKey: string, scope?: DockerImageScope): string {
  const service = scope?.service === undefined ? "" : `service-${component(scope.service, 32, "service")}-`;
  const prefix = scope ? `${scope.phase}-${service}` : "";
  // Keep the original hash for images that already used an unscoped name.
  const hash = createHash("sha256").update(JSON.stringify([null, scope?.phase, scope?.service, kind, contentKey])).digest("hex").slice(0, 24);
  return `ember-evaluator/shared:${prefix}${kind}-${hash}`;
}
