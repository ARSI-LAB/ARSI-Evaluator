import { expect, test } from "vitest";
import { classifyError } from "../../src/core/errors/classify.js";

const context = { phase: "environment", component: "docker", operation: "build" } as const;

test.each([
  '#12 [8/12] RUN case "$arch" in aarch64) true ;; *) echo "Unsupported architecture for uv"; exit 1 ;; esac',
  'Step 8/12 : RUN case "$arch" in aarch64) true ;; *) echo "Unsupported architecture for uv"; exit 1 ;; esac',
  '  15 | >>> RUN echo "Unsupported architecture for uv"',
  'ERROR: failed to solve: process "/bin/sh -c echo Unsupported architecture for uv" did not complete',
])("unexecuted recipe error strings do not imply an incompatible architecture: %s", recipe => {
  const failure = classifyError(new Error(`${recipe}\n#17 350.4 ERROR: Failed last resort of using HTTP::Tiny to download https://api.github.com/repos/example/data\nexit code: 255`), context);
  expect(failure.code).toBe("ENV_IMAGE_BUILD_FAILED");
});

test.each([
  "Unsupported architecture for uv: riscv64",
  "ENV_PREPARATION_FAILED: Unsupported architecture for uv: riscv64",
  "#12 0.14 Unsupported architecture for uv: riscv64",
  "#12 0.14 ERROR: Unsupported architecture riscv64",
  "exec /bin/bash: exec format error",
  "no matching manifest for linux/arm64/v8 in the manifest list entries",
])("actual architecture failures remain unsupported: %s", diagnostic => {
  expect(classifyError(new Error(diagnostic), context).code).toBe("ENV_ARCH_UNSUPPORTED");
});

test("build summaries retain the failing tail, length limit and redaction", () => {
  const failure = classifyError(new Error(`start\n${"Installing package\n".repeat(500)}ERROR: download failed private-secret`),
    { ...context, secrets: ["private-secret"] });
  expect(failure.message).toContain("start");
  expect(failure.message).toContain("ERROR: download failed [redacted]");
  expect(failure.message.length).toBeLessThanOrEqual(2048);
  expect(failure.message).not.toContain("private-secret");
});
