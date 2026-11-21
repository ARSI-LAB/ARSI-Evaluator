export function searchWeb(query: string, service: { api: string | null; model: string; baseUrl: string | null; apiKey: string; exaOnly?: boolean },
  signal: AbortSignal, skipExa?: boolean): Promise<{ backend: string; results: { title: string; url: string }[]; failures: string[]; content?: string }>;
