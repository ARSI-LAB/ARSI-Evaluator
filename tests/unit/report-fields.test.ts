import { expect, test } from "vitest";
import { renderMetrics, readableDuration } from "../../src/plugins/reporters/fields.js";

test("human metrics show scores and usage without field paths or explanations", () => {
  const metrics = { "success-rate": { selected: 90, denominator: 90, passed: 51, rate: 51 / 90, invalid: 0, pending: 0 },
    usage: { selected: 90, inputTokens: { total: 168034992, covered: 85 }, outputTokens: { total: 1931853, covered: 85 },
      totalTokens: { total: 169966845, covered: 85 } },
    "attempt-accounting": { attempts: 90, usage: { totalTokens: { total: 264392856, covered: 90, partialAttempts: 5 } },
      cost: { knownTotal: 12.5, unknownAttempts: 5, currency: "USD" } } };
  const original = structuredClone(metrics);
  const markdown = renderMetrics(metrics).join("\n");
  expect(markdown).toContain("| 正确率 | 56.67% |");
  expect(markdown).toContain("| 最终结果 | 168,034,992 | 1,931,853 | 169,966,845 | 85 / 90 | — |");
  expect(markdown).toContain("| 运行累计 | — | — | 264,392,856 | 90 / 90 | 5 |");
  expect(markdown).not.toContain("/success-rate");
  expect(markdown).not.toContain("attempt");
  expect(markdown).not.toContain("原始字段");
  expect(markdown).not.toContain("费用");
  expect(markdown).not.toContain("USD");
  expect(metrics).toEqual(original);
});

test("unknown plugin metrics remain readable and escaped without changing zero or missing values", () => {
  const markdown = renderMetrics({ custom: { zero: 0, missing: null, flag: false,
    message: '<script>|[bad](https://invalid) next' } }).join("\n");
  expect(markdown).toContain("| custom.zero | 0 |");
  expect(markdown).toContain("| custom.missing | — |");
  expect(markdown).toContain("| custom.flag | false |");
  expect(markdown).not.toContain("<script>");
  expect(markdown).not.toContain("[bad](https://invalid)");
  expect(readableDuration(55)).toBe("55 毫秒");
  expect(readableDuration(0)).toBe("0 秒");
});
