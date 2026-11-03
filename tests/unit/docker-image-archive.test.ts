import { expect, test, vi } from "vitest";
import { DockerImageArchiveLoader } from "ember-evaluator";
import type { DockerCommand } from "ember-evaluator";

function fixture() {
  const images = new Set<string>();
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "image") {
      if (!images.has(args[2]!)) throw new Error("image absent");
    } else if (args[0] === "load") images.add("fixture/target");
    else throw new Error("unexpected command");
    return { stdout: "fixture image", stderr: "" };
  });
  return { images, command, loader: new DockerImageArchiveLoader(command) };
}

test("concurrent image requests share work while one caller can cancel independently", async () => {
  const { command, loader, images } = fixture();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const archive = vi.fn(async (signal: AbortSignal) => { await gate; signal.throwIfAborted(); return "/fixture/archive.tar"; });
  const source = { archive, aliases: [] };
  const first = new AbortController();
  const second = new AbortController();
  const a = loader.ensure("fixture/target", source, first.signal);
  const failed = expect(a).rejects.toThrow("cancel first caller");
  const b = loader.ensure("fixture/target", source, second.signal);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  first.abort(new Error("cancel first caller"));
  await failed;
  expect(archive.mock.calls[0]?.[0].aborted).toBe(false);
  finish?.();
  await b;
  expect(command.mock.calls.filter(([args]) => args[0] === "load")).toHaveLength(1);
  images.clear();
  await loader.ensure("fixture/target", source, second.signal);
  expect(archive).toHaveBeenCalledTimes(2);
});

test("cancelling every waiter aborts the archive source and a later caller can retry", async () => {
  const { command, loader } = fixture();
  const archive = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = loader.ensure("fixture/target", { archive, aliases: [] }, controller.signal);
  const failed = expect(pending).rejects.toThrow("cancel all callers");
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  controller.abort(new Error("cancel all callers"));
  await failed;
  expect(archive.mock.calls[0]?.[0].aborted).toBe(true);
  expect(command.mock.calls.some(([args]) => args[0] === "load")).toBe(false);
  await loader.ensure("fixture/target", { archive: async () => "/fixture/archive.tar", aliases: [] }, new AbortController().signal);
  expect(command.mock.calls.some(([args]) => args[0] === "load")).toBe(true);
});
