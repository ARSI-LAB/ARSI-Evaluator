import { expectNonEmptyString, expectRecord, rejectUnknown } from "./input.js";

/** Only declared credential fields accept this reference; arbitrary data cannot grant credential access. */
export function credentialReference(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const binding = expectRecord(value, "credential reference");
  rejectUnknown(binding, ["credential"], "credential reference");
  const name = expectNonEmptyString(binding.credential, "credential reference name");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError("Invalid credential reference name");
  return name;
}

export function configurationCredentials(config: Readonly<Record<string, unknown>>, fields: readonly string[] = []): string[] {
  return fields.flatMap(field => { const name = credentialReference(config[field]); return name ? [name] : []; });
}

export async function resolveConfigurationCredentials(config: Readonly<Record<string, unknown>>, fields: readonly string[],
  credential: (name: string) => Promise<string | undefined>): Promise<Record<string, unknown>> {
  const result = { ...config };
  for (const field of fields) {
    const name = credentialReference(config[field]);
    if (!name) continue;
    const value = await credential(name);
    if (!value) throw new TypeError(`Missing credential ${name}`);
    result[field] = value;
  }
  return result;
}
