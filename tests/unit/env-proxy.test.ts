import { afterEach, expect, test, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installEnvProxy } from "../../src/adapters/net/env-proxy.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllEnvs();
  setGlobalDispatcher(new Agent());
  globalThis.fetch = originalFetch;
});

test("installs a proxy fetch when proxy environment variables are set", () => {
  vi.stubEnv("https_proxy", "http://127.0.0.1:9");
  setGlobalDispatcher(new Agent());
  installEnvProxy();
  expect(getGlobalDispatcher().constructor.name).toBe("EnvHttpProxyAgent");
  expect(globalThis.fetch).not.toBe(originalFetch);
});

test("leaves fetch unchanged when no proxy is configured", () => {
  vi.stubEnv("HTTP_PROXY", "");
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("https_proxy", "");
  const agent = new Agent();
  setGlobalDispatcher(agent);
  installEnvProxy();
  expect(getGlobalDispatcher()).toBe(agent);
  expect(globalThis.fetch).toBe(originalFetch);
});
