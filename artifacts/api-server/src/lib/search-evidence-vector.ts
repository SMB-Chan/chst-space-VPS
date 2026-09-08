import type { SearchResult } from "./search-parse";
import type {
  SearchQueryPlan,
  SearchSubqueryRole,
} from "./search-query-planner";
import type {
  SearchEvidenceDimension,
  SearchRetrievalLaneKind,
} from "./search-task-profile";

/**
 * Retrieval provenance attached to a search result.
 *
 * Dimension values are bounded retrieval signals, not factuality scores. A
 * value of 1 means that the result was retrieved through a query lane that was
 * explicitly targeting that evidence dimension. Semantic sufficiency is still
 * decided later by the evidence matrix / answer audit.
 */
export interface SearchEvidenceMetadata {
  dimensions: Partial<Record<SearchEvidenceDimension, number>>;
  queryRoles: SearchSubqueryRole[];
  providerNames: string[];
}

export interface SearchRetrievalEvidenceCoverage {
  coveredDimensions: SearchEvidenceDimension[];
  missingRequiredDimensions: SearchEvidenceDimension[];
  requiredDimensions: SearchEvidenceDimension[];
  distinctDomains: number;
}

const EVIDENCE_DIMENSIONS = [
  "primary_source",
  "freshness",
  "independence",
  "counterevidence",
  "academic",
  "technical",
  "comparison",
] as const satisfies readonly SearchEvidenceDimension[];

const EVIDENCE_DIMENSION_SET = new Set<string>(EVIDENCE_DIMENSIONS);

const ROLE_DIMENSIONS: Partial<
  Record<SearchSubqueryRole, SearchEvidenceDimension>
> = {
  official: "primary_source",
  freshness: "freshness",
  counterevidence: "counterevidence",
  comparison: "comparison",
  research: "academic",
  technical: "technical",
};

const LANE_DIMENSIONS: Record<
  SearchRetrievalLaneKind,
  SearchEvidenceDimension
> = {
  primary_source: "primary_source",
  freshness: "freshness",
  counterevidence: "counterevidence",
  comparison: "comparison",
  academic: "academic",
  technical: "technical",
  independent: "independence",
};

const DIMENSION_ROLES: Partial<
  Record<SearchEvidenceDimension, SearchSubqueryRole>
> = {
  primary_source: "official",
  freshness: "freshness",
  counterevidence: "counterevidence",
  comparison: "comparison",
  academic: "research",
  technical: "technical",
};

function boundedSignal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function mergeSearchEvidenceMetadata(
  left: SearchEvidenceMetadata | undefined,
  right: SearchEvidenceMetadata | undefined,
): SearchEvidenceMetadata | undefined {
  if (!left && !right) return undefined;
  const dimensions: SearchEvidenceMetadata["dimensions"] = {};
  for (const dimension of EVIDENCE_DIMENSIONS) {
    const value = Math.max(
      boundedSignal(left?.dimensions[dimension] ?? 0),
      boundedSignal(right?.dimensions[dimension] ?? 0),
    );
    if (value > 0) dimensions[dimension] = value;
  }
  return {
    dimensions,
    queryRoles: unique([
      ...(left?.queryRoles ?? []),
      ...(right?.queryRoles ?? []),
    ]),
    providerNames: unique([
      ...(left?.providerNames ?? []),
      ...(right?.providerNames ?? []),
    ]),
  };
}

export function annotateSearchResultsWithEvidence(
  results: SearchResult[],
  args: {
    role: SearchSubqueryRole;
    providerName?: string;
    extraDimensions?: readonly SearchEvidenceDimension[];
  },
): SearchResult[] {
  const roleDimension = ROLE_DIMENSIONS[args.role];
  const dimensions = unique([
    ...(roleDimension ? [roleDimension] : []),
    ...(args.extraDimensions ?? []),
  ]);
  const annotation: SearchEvidenceMetadata = {
    dimensions: Object.fromEntries(
      dimensions.map((dimension) => [dimension, 1]),
    ) as SearchEvidenceMetadata["dimensions"],
    queryRoles: [args.role],
    providerNames: args.providerName ? [args.providerName] : [],
  };
  return results.map((result) => ({
    ...result,
    evidence: mergeSearchEvidenceMetadata(result.evidence, annotation),
  }));
}

export function annotateSearchResultsWithProvider(
  results: SearchResult[],
  providerName: string,
): SearchResult[] {
  const annotation: SearchEvidenceMetadata = {
    dimensions: {},
    queryRoles: [],
    providerNames: providerName ? [providerName] : [],
  };
  return results.map((result) => ({
    ...result,
    evidence: mergeSearchEvidenceMetadata(result.evidence, annotation),
  }));
}

function domainOf(result: SearchResult): string {
  try {
    return new URL(result.articleUrl ?? result.url).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function requiredEvidenceDimensions(
  plan: SearchQueryPlan,
): SearchEvidenceDimension[] {
  return unique(
    plan.taskProfile.lanes
      .filter((lane) => lane.required)
      .map((lane) => LANE_DIMENSIONS[lane.kind]),
  );
}

/**
 * Measure which required retrieval lanes have actually contributed results.
 * Independence is deliberately evaluated at corpus level through domain
 * diversity instead of being stamped onto individual documents.
 */
export function assessSearchRetrievalEvidence(
  plan: SearchQueryPlan,
  results: SearchResult[],
): SearchRetrievalEvidenceCoverage {
  const covered = new Set<SearchEvidenceDimension>();
  let primaryContributed = false;
  for (const result of results) {
    if (result.evidence?.queryRoles.includes("primary")) {
      primaryContributed = true;
    }
    for (const [dimension, signal] of Object.entries(
      result.evidence?.dimensions ?? {},
    )) {
      if (
        typeof signal === "number" &&
        signal > 0 &&
        EVIDENCE_DIMENSION_SET.has(dimension)
      ) {
        covered.add(dimension as SearchEvidenceDimension);
      }
    }
  }

  // A primary query can intentionally encode an evidence constraint itself
  // (for example "明日" for freshness or `site:go.jp` for primary sources).
  // Count that only when the primary lane actually contributed a result.
  if (primaryContributed) {
    for (const dimension of plan.primaryEvidenceDimensions) {
      covered.add(dimension);
    }
  }

  const domains = new Set(results.map(domainOf).filter(Boolean));
  if (domains.size >= 2) covered.add("independence");

  const required = requiredEvidenceDimensions(plan);
  return {
    coveredDimensions: [...covered],
    missingRequiredDimensions: required.filter(
      (dimension) => !covered.has(dimension),
    ),
    requiredDimensions: required,
    distinctDomains: domains.size,
  };
}

export function supplementalRolesForEvidenceDimensions(
  dimensions: readonly SearchEvidenceDimension[],
): Set<SearchSubqueryRole> {
  return new Set(
    dimensions
      .map((dimension) => DIMENSION_ROLES[dimension])
      .filter((role): role is SearchSubqueryRole => role !== undefined),
  );
}
