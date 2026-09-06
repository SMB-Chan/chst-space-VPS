import { describe, expect, it } from "vitest";
import {
  parseArxivResults,
  parseGithubRepositoryResults,
  parseWikipediaResults,
} from "./search-vertical-providers";

describe("vertical search parsers", () => {
  it("parses Wikipedia results and strips markup", () => {
    const results = parseWikipediaResults(
      {
        query: {
          search: [
            {
              title: "Large language model",
              snippet:
                '<span class="searchmatch">Large</span> language model &amp; AI',
            },
          ],
        },
      },
      "en",
    );

    expect(results).toEqual([
      {
        title: "Large language model",
        url: "https://en.wikipedia.org/wiki/Large_language_model",
        snippet: "Large language model & AI",
      },
    ]);
  });

  it("parses bounded arXiv Atom entries and upgrades result URLs to https", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2601.12345v1</id>
          <title>  Example &amp; Paper  </title>
          <summary>First\n abstract line.</summary>
        </entry>
      </feed>`;

    expect(parseArxivResults(xml)).toEqual([
      {
        title: "Example & Paper",
        url: "https://arxiv.org/abs/2601.12345v1",
        snippet: "First abstract line.",
      },
    ]);
  });

  it("drops arXiv API error entries", () => {
    const xml = `<feed><entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title><summary>bad</summary></entry></feed>`;
    expect(parseArxivResults(xml)).toEqual([]);
  });

  it("maps GitHub repository results without trusting invalid URLs", () => {
    const results = parseGithubRepositoryResults({
      items: [
        {
          full_name: "owner/repo",
          html_url: "https://github.com/owner/repo",
          description: "Useful project",
          language: "TypeScript",
          stargazers_count: 42,
        },
        {
          full_name: "bad/repo",
          html_url: "javascript:alert(1)",
        },
      ],
    });

    expect(results).toEqual([
      {
        title: "owner/repo",
        url: "https://github.com/owner/repo",
        snippet: "Useful project · Language: TypeScript · Stars: 42",
      },
    ]);
  });
});
