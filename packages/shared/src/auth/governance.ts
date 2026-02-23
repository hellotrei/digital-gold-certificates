export const GOVERNANCE_ROLE_HEADER = "x-governance-role";
export const GOVERNANCE_ACTOR_HEADER = "x-governance-actor";

export type GovernanceRoleSet = Set<string>;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function parseGovernanceRoleHeader(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = normalizeToken(value);
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    if (typeof first !== "string") return null;
    const normalized = normalizeToken(first);
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

export function parseGovernanceActorHeader(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    if (typeof first !== "string") return null;
    const trimmed = first.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

export function parseGovernanceRoleSet(
  raw: string | undefined,
  fallbackRoles: string[],
): GovernanceRoleSet {
  const source = (raw || "").trim();
  if (!source) {
    return new Set(fallbackRoles.map(normalizeToken));
  }

  if (source === "*") {
    return new Set(["*"]);
  }

  return new Set(
    source
      .split(",")
      .map(normalizeToken)
      .filter((role) => role.length > 0),
  );
}

export function isGovernanceRoleAllowed(
  role: string | null,
  allowedRoles: GovernanceRoleSet,
): boolean {
  if (allowedRoles.has("*")) return true;
  if (!role) return false;
  return allowedRoles.has(role);
}
