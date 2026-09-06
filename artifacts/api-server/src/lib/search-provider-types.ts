import type { SearchResult } from "./search-parse";

export type SearchEngineKind = "general" | "vertical";

export interface ApiSearchProvider {
  name: string;
  /** Optional relative contribution to rank fusion; defaults to 1. */
  weight?: number;
  /** General engines are broadly useful; vertical engines need query affinity. */
  kind?: SearchEngineKind;
  /** Returns a normalized 0..1 affinity for this query. */
  queryAffinity?: (query: string) => number;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}
