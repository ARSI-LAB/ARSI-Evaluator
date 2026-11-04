/** Network locations are distinct: localhost never implicitly changes meaning. */
export type NetworkLocation = "host" | "daemon" | "build" | "runtime";
export type NetworkProxy = { http: string | null; https: string | null; noProxy: string[] };
export type AptSources = Partial<Record<"debian" | "debianSecurity" | "ubuntu" | "ubuntuSecurity" | "ubuntuPorts", string>>;
export type RegistryImageAcquisition =
  | { method: "docker" }
  | { method: "registry-client"; backend: "nodejs" | "skopeo"; skopeoExecutable: string };
export type ArchiveImageAcquisition = {
  method: "archive";
  provider: "modelscope" | "huggingface";
  baseUrl: string;
};
export type ImageAcquisition = RegistryImageAcquisition | ArchiveImageAcquisition;
export type ImageRequestContext = { taskId: string; phase: "solve" | "verify"; service?: string };
export type NetworkSettings = {
  version: 1;
  proxy: Record<NetworkLocation, NetworkProxy>;
  sources: {
    huggingface: string;
    python: { index: string; extraIndexes: string[]; interpreter: string | null };
    npm: { registry: string };
    node: { dist: string };
    github: { api: string; raw: string; repository: string };
    apt: AptSources;
  };
  docker: {
    pull: RegistryImageAcquisition;
    mirrors: Record<string, string>;
    benchmarks: Record<string, ImageAcquisition>;
    buildNetwork: "default" | "host";
  };
  git: { ssh: { route: "direct" | "proxy" } };
};

/** Templates, not coordinator-expanded proxy addresses, travel to execution nodes. */
export type NetworkDocument = {
  template: import("./task.js").JsonValue;
  settings: NetworkSettings;
  origin: string;
  digest: string;
};
export type NetworkSnapshot = { benchmarkName: string; template: import("./task.js").JsonValue };

export interface NetworkAccess {
  readonly document: NetworkDocument;
  readonly settings: NetworkSettings;
  readonly secrets: readonly string[];
  fetch: typeof globalThis.fetch;
  environment(location: NetworkLocation, base?: NodeJS.ProcessEnv, target?: "host" | "container"): Record<string, string>;
  sourceUrl(url: string): string;
}
