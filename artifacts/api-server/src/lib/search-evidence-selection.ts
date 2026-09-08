import { requiredEvidenceDimensions } from "./search-evidence-vector";
import type { SearchQueryPlan } from "./search-query-planner";
import type { SearchResult } from "./search-parse";
import type { SearchEvidenceDimension } from "./search-task-profile";

function resultHostname(result: SearchResult): string {
  try {
    return new URL(result.articleUrl ?? result.url).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function coversDimension(
  result: SearchResult,
  dimension: SearchEvidenceDimension,
): boolean {
  return (result.evidence?.dimensions[dimension] ?? 0) > 0;
}

function addSelectedIndex(
  selected: number[],
  selectedSet: Set<number>,
  index: number,
): void {
  if (selectedSet.has(index)) return;
  selected.push(index);
  selectedSet.add(index);
}

/**
 * Allocate the bounded full-page fetch budget without collapsing retrieval
 * evidence into the relevance score.
 *
 * Search ranking still decides ordinary result order. When a task has required
 * evidence dimensions, this selector only prevents the page-hydration budget
 * from accidentally dropping a lower-ranked result that came from a required
 * retrieval lane (for example primary-source or counterevidence). Independence
 * is handled as a corpus-level domain property rather than a per-document flag.
 *
 * Retrieval provenance is not a factuality score: semantic sufficiency remains
 * the responsibility of the evidence matrix and answer audit.
 */
export function selectEvidenceAwareFetchCandidates(
  results: readonly SearchResult[],
  plan: SearchQueryPlan | undefined,
  maxResults: number,
): SearchResult[] {
  const limit = Number.isFinite(maxResults)
    ? Math.max(0, Math.floor(maxResults))
    : 0;
  if (limit === 0 || results.length === 0) return [];
  if (!plan) return results.slice(0, limit);

  const required = requiredEvidenceDimensions(plan);
  if (required.length === 0) return results.slice(0, limit);

  const explicitRequired = required.filter(
    (dimension) => dimension !== "independence",
  );
  const uncovered = new Set<SearchEvidenceDimension>(explicitRequired);
  const selected: number[] = [];
  const selectedSet = new Set<number>();

  // Greedy set coverage over required retrieval dimensions. Ties keep the
  // original ranked order, so evidence coverage changes as little as possible.
  while (selected.length < limit && uncovered.size > 0) {
    let bestIndex = -1;
    let bestGain = 0;
    for (let index = 0; index < results.length; index += 1) {
      if (selectedSet.has(index)) continue;
      let gain = 0;
      for (const dimension of uncovered) {
        if (coversDimension(results[index], dimension)) gain += 1;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestGain === 0) break;
    addSelectedIndex(selected, selectedSet, bestIndex);
    for (const dimension of [...uncovered]) {
      if (coversDimension(results[bestIndex], dimension)) {
        uncovered.delete(dimension);
      }
    }
  }

  if (required.includes("independence") && selected.length < limit) {
    // Establish a first domain when no explicit evidence result was selected.
    if (selected.length === 0) addSelectedIndex(selected, selectedSet, 0);

    const domains = new Set(
      selected.map((index) => resultHostname(results[index])).filter(Boolean),
    );
    if (domains.size < 2 && selected.length < limit) {
      for (let index = 0; index < results.length; index += 1) {
        if (selectedSet.has(index)) continue;
        const domain = resultHostname(results[index]);
        if (!domain || domains.has(domain)) continue;
        addSelectedIndex(selected, selectedSet, index);
        domains.add(domain);
        break;
      }
    }
  }

  // Spend the remainder on the existing relevance ranking.
  for (
    let index = 0;
    index < results.length && selected.length < limit;
    index += 1
  ) {
    addSelectedIndex(selected, selectedSet, index);
  }

  return selected.map((index) => results[index]);
}
