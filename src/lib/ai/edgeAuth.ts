export const EDGE_APP_SECRET_HEADER = "x-verbatim-app-secret";

export function edgeAppSecretHeaders(
  secret = import.meta.env.VITE_VERBATIM_EDGE_APP_SECRET as string | undefined,
): Record<string, string> {
  const value = secret?.trim();
  return value ? { [EDGE_APP_SECRET_HEADER]: value } : {};
}

export function serializeDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  return String(Math.max(0, Math.round(durationMs)));
}
