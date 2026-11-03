import { expect, test } from "vitest";
import { dockerBuildNetwork } from "../../src/adapters/containers/build-network.js";

test("pip mixed-manager override is opt-in and changes the build identity", () => {
  const ordinary = dockerBuildNetwork({});
  const overlay = dockerBuildNetwork({ PIP_IGNORE_INSTALLED: "1" });
  expect(ordinary.identity).not.toHaveProperty("pipIgnoreInstalled");
  expect(ordinary.buildArgs.some(value => value.startsWith("PIP_IGNORE_INSTALLED="))).toBe(false);
  expect(overlay.identity).toHaveProperty("pipIgnoreInstalled", "1");
  expect(overlay.buildArgs).toContain("PIP_IGNORE_INSTALLED=1");
  expect(overlay.identity).not.toEqual(ordinary.identity);
});

test("invalid pip build options fail before creating a Docker command", () => {
  expect(() => dockerBuildNetwork({ PIP_IGNORE_INSTALLED: "arbitrary command" })).toThrow(/PIP_IGNORE_INSTALLED/);
});
