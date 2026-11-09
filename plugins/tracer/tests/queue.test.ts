import { expect, test } from "vitest";
import { AsyncQueue } from "../collector/runtime.js";

test("whenIdle waits until every enqueued item is completed", async () => {
  const queue = new AsyncQueue<number>(8);
  queue.push(1);
  queue.push(2);
  let idle = false;
  const barrier = queue.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  expect(idle).toBe(false);

  expect(await queue.shift()).toBe(1);
  queue.complete();
  await Promise.resolve();
  expect(idle).toBe(false);

  expect(await queue.shift()).toBe(2);
  queue.complete();
  await barrier;
  expect(idle).toBe(true);
});

test("whenIdle tracks items handed directly to a waiting consumer", async () => {
  const queue = new AsyncQueue<number>(1);
  await queue.whenIdle();

  const shifted = queue.shift();
  expect(queue.push(1)).toBe(true);
  expect(await shifted).toBe(1);

  let idle = false;
  const barrier = queue.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  expect(idle).toBe(false);

  queue.complete();
  await barrier;
  expect(idle).toBe(true);
});
