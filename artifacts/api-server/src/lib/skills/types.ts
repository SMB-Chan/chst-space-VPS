export interface ChatSkill {
  id: string;
  label: string;
  /** Case-insensitive; matched against the user message. */
  trigger: RegExp;
  /** When true, skip the judge LLM and search immediately. */
  forceSearch?: boolean;
  /** Extra terms appended to the search query. */
  searchHint?: string;
  prompt: string;
}
