import { canonicalize } from "json-canonicalize";

/**
 * Canonical JSON per RFC 8785 (JCS).
 * Canonicalize before hashing/signing for stable outputs.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}
