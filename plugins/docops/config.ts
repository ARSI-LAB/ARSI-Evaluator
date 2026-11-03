export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function parseRepositoryConfig(config: Record<string, unknown>, path: string): { repository: string; revision: string } {
  const repository = expectNonEmptyString(config.repository ?? "icip-cas/DocOps", `${path}.repository`);
  const revision = expectNonEmptyString(config.revision ?? "main", `${path}.revision`);
  if (!REPOSITORY_PATTERN.test(repository)) throw new TypeError(`${path}.repository must be a GitHub owner/repository`);
  if (!REVISION_PATTERN.test(revision) || revision.includes("..") || revision.endsWith("/")) {
    throw new TypeError(`${path}.revision must be a Git commit, branch, or tag`);
  }
  return { repository, revision };
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) throw new TypeError(`${path} contains unknown field ${unknown}`);
}

export function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}
