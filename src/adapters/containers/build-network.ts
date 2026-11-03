export const DEFAULT_PIP_INDEX_URL = "https://repo.huaweicloud.com/repository/pypi/simple";
export const DEFAULT_DEBIAN_MIRROR = "https://repo.huaweicloud.com";

type VerifierBuildNetworkSettings = {
  identity: { debianMirror: string; pipIndex: string; githubMirror: string; network: "default" | "host"; proxy: Record<string, string>; pipIgnoreInstalled?: string; npmRegistry?: string };
  buildArgs: string[];
};

function httpUrl(value: string, label: string, originOnly = false): string {
  let url: URL;
  try { url = new URL(value); } catch (cause) { throw new TypeError(label + " must be an HTTP(S) URL", { cause }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /[\s\\"'`$|]/u.test(value) || (originOnly && url.pathname !== "/"))
    throw new TypeError(label + " must be a credential-free HTTP(S) " + (originOnly ? "origin" : "URL"));
  return originOnly ? url.origin : url.href;
}

export function dockerBuildNetwork(env: NodeJS.ProcessEnv = process.env): VerifierBuildNetworkSettings {
  const network = env.EVALUATOR_DOCKER_BUILD_NETWORK || "default";
  if (network !== "default" && network !== "host") throw new TypeError("EVALUATOR_DOCKER_BUILD_NETWORK must be default or host");
  const debianMirror = httpUrl(env.EVALUATOR_DEBIAN_MIRROR || DEFAULT_DEBIAN_MIRROR, "EVALUATOR_DEBIAN_MIRROR", true);
  const pipIndex = httpUrl(env.UV_DEFAULT_INDEX || env.UV_INDEX_URL || env.PIP_INDEX_URL || DEFAULT_PIP_INDEX_URL, "Python package index");
  const githubMirror = httpUrl(env.EVALUATOR_GITHUB_MIRROR || "https://github.com/", "EVALUATOR_GITHUB_MIRROR").replace(/\/?$/u, "/");
  const registry = env.NPM_CONFIG_REGISTRY || env.npm_config_registry;
  const npmRegistry = registry ? httpUrl(registry, "NPM_CONFIG_REGISTRY") : undefined;
  const pipIgnoreInstalled = env.PIP_IGNORE_INSTALLED;
  if (pipIgnoreInstalled !== undefined && !["0", "1", "false", "true"].includes(pipIgnoreInstalled))
    throw new TypeError("PIP_IGNORE_INSTALLED must be 0, 1, false or true");
  const proxy: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
    const value = env[key] || env[key.toLowerCase()];
    if (!value) continue;
    let url = httpUrl(value, key);
    if (network !== "host") url = url.replace(/\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/u, "//host.docker.internal");
    proxy[key] = proxy[key.toLowerCase()] = url;
  }
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) proxy.NO_PROXY = proxy.no_proxy = noProxy;
  const buildArgs = [
    ...(network === "host" ? ["--network", "host"] : []),
    "--add-host", "host.docker.internal:host-gateway",
    ...Object.entries({ EVALUATOR_DEBIAN_MIRROR: debianMirror, PIP_INDEX_URL: pipIndex,
      EVALUATOR_GITHUB_MIRROR: githubMirror, ...(pipIgnoreInstalled === undefined ? {} : { PIP_IGNORE_INSTALLED: pipIgnoreInstalled }),
      ...(npmRegistry === undefined ? {} : { NPM_CONFIG_REGISTRY: npmRegistry, npm_config_registry: npmRegistry, COREPACK_NPM_REGISTRY: npmRegistry }), ...proxy }).flatMap(([key, value]) => ["--build-arg", key + "=" + value]),
  ];
  return { identity: { debianMirror, pipIndex, githubMirror, network, proxy,
    ...(pipIgnoreInstalled === undefined ? {} : { pipIgnoreInstalled }), ...(npmRegistry === undefined ? {} : { npmRegistry }) }, buildArgs };
}

export { dockerBuildNetwork as verifierBuildNetwork };
