import { rm } from "node:fs/promises";
// Only reset controlled fixture state; never delete evidence or dataset caches.
for (const name of ["wait-once.marker", "crash-once.marker", "office-wait-once.marker"]) {
  await rm(`/experiment/${name}`, { force: true });
}
