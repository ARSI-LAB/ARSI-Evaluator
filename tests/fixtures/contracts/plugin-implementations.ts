import type {
  Verifier,
  AttemptRecord,
  Benchmark,
  Environment,
  Metrics,
  Reporter,
  ResultSnapshot,
  RunStore,
  Solver,
  TaskScheduler,
} from "../../../src/index.js";

const unreachable = (): never => {
  throw new Error("type-conformance fixture only");
};

export const benchmarkFixture = {
  resolveSource: async () => unreachable(),
  enumerate: async function* () {},
  prepare: async () => unreachable(),
  verify: async () => unreachable(),
} satisfies Benchmark;

export const environmentFixture = {
  prepare: async () => unreachable(),
} satisfies Environment;

export const solverFixture = {
  requirements: () => [],
  solve: async () => unreachable(),
} satisfies Solver;

export const metricsFixture = {
  name: "fixture",
  compute: async () => null,
} satisfies Metrics;

export const reporterFixture = {
  render: async () => "fixture",
} satisfies Reporter;

export const runStoreFixture = {
  create: async () => undefined,
  open: async () => unreachable(),
  allocate: async () => unreachable(),
  listAttempts: async () => [],
  updateRun: async () => undefined,
  commit: async () => undefined,
  snapshot: async (): Promise<ResultSnapshot> => unreachable(),
  saveReportBundle: async () => undefined,
  close: async () => undefined,
} satisfies RunStore;

export const schedulerFixture = {
  executeReady: async function* (): AsyncIterable<AttemptRecord> {},
} satisfies TaskScheduler;

export const verifierFixture: Verifier = {
  async prepare(task) { return { id: task.id }; },
  async verify() { return { rewards: { reward: 1 }, details: {} }; },
};
