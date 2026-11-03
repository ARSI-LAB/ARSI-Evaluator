import { expect, test } from "vitest";
import { dockerBuildNetwork } from "../../src/adapters/containers/build-network.js";

test("npm registry is opt-in, reaches package managers and participates in build identity", () => {
  const ordinary = dockerBuildNetwork({});
  expect(ordinary.identity).not.toHaveProperty("npmRegistry");
  expect(ordinary.buildArgs.some(value => /^(?:NPM_CONFIG_REGISTRY|npm_config_registry|COREPACK_NPM_REGISTRY)=/u.test(value))).toBe(false);
  const mirror = dockerBuildNetwork({ NPM_CONFIG_REGISTRY: "https://packages.example.test/npm" });
  expect(mirror.identity.npmRegistry).toBe("https://packages.example.test/npm");
  for (const key of ["NPM_CONFIG_REGISTRY", "npm_config_registry", "COREPACK_NPM_REGISTRY"])
    expect(mirror.buildArgs).toContain(key + "=https://packages.example.test/npm");
  expect(mirror.identity).not.toEqual(ordinary.identity);
  expect(dockerBuildNetwork({ npm_config_registry: "https://packages.example.test/npm" })).toEqual(mirror);
  expect(dockerBuildNetwork({ npm_config_registry: "https://ignored.example.test", NPM_CONFIG_REGISTRY: "https://packages.example.test/npm" })).toEqual(mirror);
});

test.each(["file:///tmp/npm", "https://user:password@example.test/", "https://example.test/?token=secret", "https://example.test/#fragment", "https://example.test/a'$HOME"])("rejects unsafe npm registry %s", registry => {
  expect(() => dockerBuildNetwork({ NPM_CONFIG_REGISTRY: registry })).toThrow(/NPM_CONFIG_REGISTRY/);
});
