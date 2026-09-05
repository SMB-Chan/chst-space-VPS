/**
 * Resolve the OpenRouter secret without exposing its value.
 *
 * OPEN_ROUTER is the workspace secret name currently used by this project.
 * OPENROUTER_API_KEY remains supported for existing environments.
 */
export function resolveOpenRouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.OPEN_ROUTER?.trim() || env.OPENROUTER_API_KEY?.trim() || undefined;
}
