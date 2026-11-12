import { expect, test, vi } from "vitest";
import { apply } from "../../src/runtimes/dsh/assets/tool-policy.mjs";

test("DSH filters each scope's admitted tools and denies execution independently", async () => {
  const agent = {};
  const anotherAgent = {};
  const originalView = new Map([["bash", {}], ["private", {}], ["web_fetch", {}]]);
  const dispose = vi.fn();
  const originalResolve = vi.fn(async () => ({ dispose, view: scope => scope === agent ? originalView : new Map() }));
  const guardDisposer = vi.fn();
  const originalAssemble = vi.fn(async () => ({ tools: [{ name: "run_code" }], sections: ["harness"] }));
  const ctx = {
    tools: { resolve: originalResolve, guard: vi.fn(() => guardDisposer) },
    systemPrompt: { assemble: originalAssemble },
    on: vi.fn(),
  };
  apply(ctx, { tools: "none" });

  const step = await ctx.tools.resolve({ agent });
  expect([...step.view(agent)]).toEqual([]);
  expect([...step.view(anotherAgent)]).toEqual([]);
  await expect(ctx.systemPrompt.assemble()).resolves.toEqual({ tools: [], sections: ["harness"] });
  expect(ctx.tools.guard.mock.calls[0][0]({ name: "run_code" })).toMatch(/Disabled/u);
  expect([...originalView.keys()]).toEqual(["bash", "private", "web_fetch"]);
  step.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  ctx.on.mock.calls[0][1]();
  expect(ctx.tools.resolve).toBe(originalResolve);
  expect(ctx.systemPrompt.assemble).toBe(originalAssemble);
  expect(guardDisposer).toHaveBeenCalledOnce();
});

test("DSH reports enabled web tools missing from the selected service", async () => {
  const dispose = vi.fn();
  const ctx = {
    tools: { resolve: async () => ({ dispose, view: () => new Map() }), guard: () => () => {} },
    systemPrompt: { async assemble() { return { tools: [] }; } },
    on() {},
  };
  apply(ctx, { webSearch: "enabled" });
  await expect(ctx.tools.resolve({ agent: {} })).rejects.toThrow(/web_search is unavailable/u);
  expect(dispose).toHaveBeenCalledOnce();
});
