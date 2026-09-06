import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSearchEngineRuntimeForTests,
  resetSearchProviderHealthForTests,
  searchWithProviders,
  type ApiSearchProvider,
} from "./search-providers";
import type { SearchResult } from "./search-parse";

function result(host: string, path: string): SearchResult {
  return {
    title: path,
    url: `https://${host}/${path}`,
    snippet: `${path} snippet`,
  };
}

function stub(
  name: string,
  options: Partial<ApiSearchProvider> = {},
): ApiSearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name,
    search: vi.fn(async () => [result(`${name}.example`, "1")]),
    ...options,
  };
}

afterEach(() => {
  delete process.env.SEARCH_INITIAL_FANOUT;
  resetSearchEngineRuntimeForTests();
  resetSearchProviderHealthForTests();
});

describe("dynamic search engine registry", () => {
  it("puts a matching vertical engine into the initial two-engine wave", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "2";
    const generalA = stub("general-a", { kind: "general" });
    const generalB = stub("general-b", { kind: "general" });
    const github = stub("github", {
      kind: "vertical",
      queryAffinity: (query) => (query.includes("GitHub") ? 0.98 : 0.1),
    });

    await searchWithProviders("GitHub repository search", [
      generalA,
      generalB,
      github,
    ]);

    expect(github.search).toHaveBeenCalledOnce();
    expect(generalA.search).toHaveBeenCalledOnce();
    expect(generalB.search).toHaveBeenCalledOnce();
  });

  it("does not run an unrelated vertical engine even during fallback", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "1";
    const general = stub("general", { kind: "general" });
    general.search.mockResolvedValue([
      result("same.example", "1"),
      result("same.example", "2"),
    ]);
    const unrelated = stub("arxiv", {
      kind: "vertical",
      queryAffinity: () => 0.1,
    });

    await searchWithProviders("weather tomorrow", [general, unrelated]);

    expect(general.search).toHaveBeenCalledOnce();
    expect(unrelated.search).not.toHaveBeenCalled();
  });
});
