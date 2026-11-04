import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Tests choose their own network overrides instead of inheriting the developer's proxies or mirrors.
for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "HF_ENDPOINT", "UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_PYTHON_INSTALL_MIRROR",
  "NPM_CONFIG_REGISTRY", "npm_config_registry", "EVALUATOR_NODE_MIRROR", "EVALUATOR_GITHUB_MIRROR", "EVALUATOR_DEBIAN_MIRROR",
  "EVALUATOR_DOCKER_BUILD_NETWORK", "EVALUATOR_NETWORK_CONFIG"]) delete process.env[name];

// Configuration tests must never read or overwrite the developer's ~/.ember-evaluator.
const testHome = mkdtempSync(join(tmpdir(), "evaluator-test-home-"));
vi.mock("node:os", async importOriginal => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testHome };
});
afterAll(() => rmSync(testHome, { recursive: true, force: true }));
