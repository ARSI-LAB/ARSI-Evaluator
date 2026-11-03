import { expectTypeOf, test } from "vitest";
import type {
  Benchmark,
  Verifier,
  Environment,
  JsonValue,
  Metrics,
  PublicTask,
  Reporter,
  RunStore,
  Solver,
  TaskScheduler,
} from "../../src/index.js";
import {
  benchmarkFixture,
  verifierFixture,
  environmentFixture,
  metricsFixture,
  reporterFixture,
  runStoreFixture,
  schedulerFixture,
  solverFixture,
} from "../fixtures/contracts/plugin-implementations.js";

test("solver 接口仅接收公开题目", () => {
  expectTypeOf<Parameters<Solver["solve"]>[0]>().toEqualTypeOf<PublicTask>();

  const input: PublicTask = { id: "test:0", prompt: "Compute 1 + 1" };

  // @ts-expect-error verification 不属于公开输入
  void input.verification;
});

test("JSON 协议排除不可序列化值", () => {
  expectTypeOf<{ nested: [string, number, boolean, null] }>()
    .toMatchTypeOf<JsonValue>();

  // @ts-expect-error 函数不能进入公共 JSON 协议
  const invalid: JsonValue = () => undefined;
  void invalid;
});

test("fixture 覆盖八类插件角色", () => {
  expectTypeOf(verifierFixture).toMatchTypeOf<Verifier>();
  expectTypeOf(benchmarkFixture).toMatchTypeOf<Benchmark>();
  expectTypeOf(environmentFixture).toMatchTypeOf<Environment>();
  expectTypeOf(solverFixture).toMatchTypeOf<Solver>();
  expectTypeOf(metricsFixture).toMatchTypeOf<Metrics>();
  expectTypeOf(reporterFixture).toMatchTypeOf<Reporter>();
  expectTypeOf(runStoreFixture).toMatchTypeOf<RunStore>();
  expectTypeOf(schedulerFixture).toMatchTypeOf<TaskScheduler>();
});
