import { financeAnalysisSkill } from "./finance-analysis";
import type { ChatSkill } from "./types";

export type { ChatSkill };

/** Registered skills. First match order is the injection order. */
export const CHAT_SKILLS: ChatSkill[] = [financeAnalysisSkill];

export function matchSkills(text: string): ChatSkill[] {
  const sample = text.slice(0, 4000);
  return CHAT_SKILLS.filter((skill) => skill.trigger.test(sample));
}

export function composeSkillSearchQuery(userText: string, skills: ChatSkill[]): string | undefined {
  const forced = skills.filter((s) => s.forceSearch);
  if (forced.length === 0) return undefined;
  const base = userText.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!base) return undefined;
  const hints = forced.map((s) => s.searchHint).filter((h): h is string => Boolean(h));
  return [base, ...hints].join(" ").trim();
}
