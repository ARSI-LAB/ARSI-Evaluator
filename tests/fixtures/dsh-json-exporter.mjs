// Controlled equivalent of alpha.2's bounded exporter. Its entry signature and
// package location exercise the adapter before the upstream projection loses data.
export function boundJsonLine(event, maxStringBytes = 8192, maxEventBytes = 32768) {
  const bounded = { ...event };
  for (const [key, value] of Object.entries(bounded)) {
    if (typeof value === "string" && Buffer.byteLength(value) > maxStringBytes) {
      bounded[key] = Buffer.from(value).subarray(0, maxStringBytes).toString("utf8");
      bounded.truncated = true;
    }
  }
  const line = JSON.stringify(bounded);
  return Buffer.byteLength(line) + 1 <= maxEventBytes ? line : JSON.stringify({ type: event.type, truncated: true });
}
