/** Trusted declaration from the installed plugin, never accepted from a job payload. */
export type PluginConfigTransport = {
  /** Credential values omitted from dispatch and rebuilt from execution-host authentication. */
  secretFields?: readonly string[];
  /** Top-level configuration fields rebuilt on the execution host. */
  nodeLocal?: Readonly<Record<string, "cache" | "docker">>;
  /** Exact paths to container strings; * matches one object key or array index. */
  containerPaths?: readonly (readonly string[])[];
  /** Pure component-specific checks, e.g. rejecting coordinator-local datasets. */
  validate?: (config: Record<string, unknown>) => void;
};

export type ConfigTransportLookup = (role: string, name: string) => PluginConfigTransport | undefined;
