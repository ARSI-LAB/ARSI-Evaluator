export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${path} contains unknown field ${unknown}`);
  }
}

export function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

export function expectPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive integer greater than zero`);
  }
  return value;
}
