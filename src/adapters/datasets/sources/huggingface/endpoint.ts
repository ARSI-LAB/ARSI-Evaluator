export type HuggingFaceTransport = { apiBase: string; fileBase: string };

// Direct egress to huggingface.co is unreliable on CN networks, so the mirror
// ships as the default (matching the pinned mirrors of the Ray smoke cluster).
// Set HF_ENDPOINT=https://huggingface.co to restore the official origin.
const DEFAULT_ENDPOINT = "https://hf-mirror.com";

/** Hub origin. `HF_ENDPOINT=https://hf-mirror.com` replaces huggingface.co for API and file URLs. */
export function huggingfaceEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HF_ENDPOINT?.trim();
  if (!raw) return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  const hasPath = url.pathname !== "/" && url.pathname !== "";
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || hasPath) {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  return url.origin;
}

export function huggingfaceTransport(env: NodeJS.ProcessEnv = process.env): HuggingFaceTransport {
  const endpoint = huggingfaceEndpoint(env);
  return { apiBase: endpoint, fileBase: endpoint };
}
