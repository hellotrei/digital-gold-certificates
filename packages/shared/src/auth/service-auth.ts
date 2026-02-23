export const SERVICE_AUTH_HEADER = "x-service-token";

export function normalizeServiceAuthToken(token: string | undefined | null): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildServiceAuthHeaders(
  token: string | undefined | null,
): Record<string, string> {
  const normalized = normalizeServiceAuthToken(token);
  if (!normalized) return {};
  return { [SERVICE_AUTH_HEADER]: normalized };
}

export function isServiceAuthAuthorized(
  providedHeader: unknown,
  expectedToken: string | undefined | null,
): boolean {
  const expected = normalizeServiceAuthToken(expectedToken);
  if (!expected) return true;

  if (Array.isArray(providedHeader)) {
    return providedHeader.some((value) => value === expected);
  }
  return typeof providedHeader === "string" && providedHeader === expected;
}
