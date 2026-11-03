import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    include: ["tests/e2e/**/*.live.test.ts"],
    passWithNoTests: false,
  },
});
