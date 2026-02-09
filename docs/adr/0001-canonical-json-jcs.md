# ADR 0001 — Canonical JSON via RFC 8785 (JCS)

## Context
Certificate payloads must be hashed consistently across platforms and runtimes.

## Decision
Use JSON Canonicalization Scheme (RFC 8785) to canonicalize JSON before hashing.

## Consequences
- Stable hashes across runtimes
- Requires strict canonicalization rules (number formatting, key ordering)
