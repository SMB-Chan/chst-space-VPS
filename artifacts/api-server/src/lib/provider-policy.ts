/** Shared by chat, discovery and media transports; evaluated at call time. */
export function isProviderFrozen(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag =
    provider === "openai"
      ? env.DISABLE_OPENAI_MODELS
      : provider === "dashscope"
        ? env.DISABLE_DASHSCOPE_MODELS
        : undefined;
  return flag?.trim().toLowerCase() === "true";
}
