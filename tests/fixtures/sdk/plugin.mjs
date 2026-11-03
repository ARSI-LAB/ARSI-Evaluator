import { appendFileSync } from "node:fs";
import { apply as registerCliFixture } from "./cli.mjs";

export const inject = ["evaluator"];
export function apply(ctx) {
  appendFileSync(new URL("./lifecycle.log", import.meta.url), "registered\n");
  ctx.effect(() => () => appendFileSync(new URL("./lifecycle.log", import.meta.url), "disposed\n"));
  registerCliFixture(ctx);
}
