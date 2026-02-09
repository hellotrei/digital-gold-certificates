# ADR 0002 — Issuer signatures with Ed25519

## Context
Certificates must remain verifiable even if APIs are offline/untrusted.

## Decision
Issuer signs the certificate hash with Ed25519.

## Consequences
- Fast + widely supported
- Simple issuer key management
