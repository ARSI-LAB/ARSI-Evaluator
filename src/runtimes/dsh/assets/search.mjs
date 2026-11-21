import { searchWeb } from "../../../infrastructure/network/web-search.mjs";

export const name = "evaluator-search";
export const inject = ["web"];

export function apply(ctx, service) {
  const web = ctx.web;
  const originalSearch = web.search;
  const originalReady = web.searchReady;
  web.searchReady = async () => true;
  web.search = async function (request, signal = new AbortController().signal) {
    let reason;
    try {
      const native = await originalSearch.call(this, request, signal);
      if (native.sources.length) return native;
      reason = "no sources";
    } catch (error) {
      signal.throwIfAborted();
      reason = error.code ?? "search unavailable";
    }
    const found = await searchWeb(request.query, { ...service, apiKey: process.env.ARSI_EVALUATOR_API_KEY }, signal);
    const sources = found.results.slice(0, request.maxResults ?? found.results.length);
    return { sources, truncated: sources.length < found.results.length,
      content: ["Native search: " + reason, ...found.failures, "Search backend: " + found.backend, found.content].filter(Boolean).join("\n") };
  };
  ctx.on("dispose", () => {
    web.search = originalSearch;
    web.searchReady = originalReady;
  });
}
