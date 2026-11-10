/** Validate the complete precision protocol before any worker is started. */
export function parseKernelSeeds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length ||
      value.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff))
    throw new TypeError("seeds must contain unsigned 32-bit integers");
  if (new Set(value).size !== value.length) throw new TypeError("seeds must be unique");
  return value;
}
