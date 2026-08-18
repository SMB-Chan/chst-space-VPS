import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { customFetch, type ErrorType } from "./custom-fetch";
import type { OpenaiConversation, OpenaiError } from "./generated/api.schemas";

export function getUpdateOpenaiConversationUrl(id: number): string {
  return `/api/openai/conversations/${id}`;
}

export function updateOpenaiConversation(
  id: number,
  data: { title: string },
  options?: Parameters<typeof customFetch>[1],
): Promise<OpenaiConversation> {
  return customFetch<OpenaiConversation>(getUpdateOpenaiConversationUrl(id), {
    ...options,
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(data),
  });
}

export function useUpdateOpenaiConversation<
  TError = ErrorType<OpenaiError>,
  TContext = unknown,
>(options?: {
  mutation?: UseMutationOptions<
    OpenaiConversation,
    TError,
    { id: number; data: { title: string } },
    TContext
  >;
  request?: Parameters<typeof customFetch>[1];
}): UseMutationResult<
  OpenaiConversation,
  TError,
  { id: number; data: { title: string } },
  TContext
> {
  return useMutation({
    mutationKey: ["updateOpenaiConversation"],
    mutationFn: ({ id, data }) => updateOpenaiConversation(id, data, options?.request),
    ...options?.mutation,
  });
}
