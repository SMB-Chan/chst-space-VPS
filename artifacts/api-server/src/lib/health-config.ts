export function shouldIncludeOperationalHealthMetrics(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HEALTH_INCLUDE_OPERATIONAL_METRICS?.trim() === "1";
}
