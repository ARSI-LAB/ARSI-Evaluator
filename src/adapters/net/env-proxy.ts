import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

function proxyEnvPresent(): boolean {
  return Boolean(
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy,
  );
}

/**
 * npm undici replaces Node's startup dispatcher with a direct Agent. When a
 * proxy is configured, install that package's fetch and point its dispatcher
 * at the proxy so evaluator downloads and pi model calls share it.
 */
export function installEnvProxy(): void {
  if (!proxyEnvPresent()) return;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  install();
}
