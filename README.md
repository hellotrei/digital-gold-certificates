# Digital Gold Certificates (DGC)

Tamper-evident, peer-to-peer proof-of-ownership system for custodied physical gold.

This repository implements a portfolio-grade architecture where:
- Certificates are canonicalized, hashed, and digitally signed.
- Ownership movements are committed on-chain as verifiable events.
- Trading UX (listing, escrow, settlement, disputes) runs off-chain.
- Inventory reconciliation and risk signals protect operational integrity.

## Whitepaper

- Main reference: [Digital Gold Certificates Whitepaper (PDF)](./docs/whitepaper/Digital%20Gold%20Certificates%20Whitepaper.pdf)
- Date: February 08, 2026
- Scope: technical concept + BRD appendix for portfolio prototyping

## Why This Project Is Strong

- End-to-end verifiability: every transfer has cryptographic proof and blockchain lineage.
- Production-minded controls: reconciliation, freeze switches, risk scoring, and dispute hooks.
- Practical architecture: separates custody, certificate lifecycle, and marketplace settlement.
- Senior-level deliverables: threat model, timeline visualizer, auditable event streams.

## Core Capabilities

- Certificate issuance and signing (Ed25519)
- Canonical JSON hashing (RFC 8785 / JCS + SHA-256)
- On-chain ownership event registry
- QR/public verification view
- P2P listing + escrow lock + settlement flow
- Split certificate support for partial transfers
- Reconciliation checks between physical inventory and outstanding claims
- Risk stream for anomaly patterns (velocity, wash trading behavior, repeat disputes)
- Auto-freeze flag on reconciliation threshold breaches

## High-Level Architecture

```mermaid
flowchart LR
    U["User Wallet/App"] --> V["Web Verifier (QR + Timeline)"]
    U --> M["Marketplace Service"]
    M --> C["Certificate Service"]
    C --> L["Ledger Adapter"]
    L --> B["Blockchain (Ownership Events)"]
    C --> K["Custody Ledger"]
    B --> R["Risk Stream"]
    M --> R
```

## Certificate Lifecycle

`ISSUED -> ACTIVE -> LOCKED -> TRANSFERRED/SPLIT -> REDEEMED`  
`REVOKED` is a terminal safety state for invalid/fraud scenarios.

## Monorepo Structure

- `contracts/` Hardhat smart contracts and tests
- `services/certificate-service/` certificate lifecycle APIs
- `services/ledger-adapter/` chain proof commit/verify adapter
- `services/marketplace-service/` listing, escrow, settlement logic
- `services/risk-stream/` event-driven risk scoring pipeline
- `services/reconciliation-service/` custody-vs-claims reconciliation and freeze control
- `services/dispute-service/` dispute intake, assignment, and resolution lifecycle
- `apps/web-verifier/` public certificate verifier UI (Next.js)
- `packages/shared/` shared crypto utilities and domain types
- `docs/whitepaper/` whitepaper and supporting docs

## Requirements

- Node.js >= 20
- pnpm >= 9

## Quick Start

```bash
pnpm install
pnpm dev
```

Run tests:

```bash
pnpm -C contracts test
```

## Milestone 12 (Current)

Milestone 12 adds governance RBAC hardening:
- Governance role headers:
  - `x-governance-role`
  - `x-governance-actor` (optional but recommended for actor consistency checks)
- `dispute-service` RBAC:
  - `POST /disputes/:disputeId/assign` requires allowed governance role
    - payload now includes `assignedBy` and `assignee`
  - `POST /disputes/:disputeId/resolve` requires allowed governance role
    - payload uses `resolvedBy` + resolution fields
  - role config via:
    - `DISPUTE_ASSIGN_ALLOWED_ROLES` (default: `ops_admin,ops_agent,admin`)
    - `DISPUTE_RESOLVE_ALLOWED_ROLES` (default: `ops_admin,ops_lead,admin`)
- `reconciliation-service` RBAC:
  - `POST /freeze/unfreeze` requires allowed governance role
  - role config via `RECON_UNFREEZE_ALLOWED_ROLES` (default: `ops_admin,admin`)
- Additional actor consistency guard:
  - if `x-governance-actor` is set, it must match body actor field (`assignedBy`/`resolvedBy`/`actor`)

Milestone 11 dispute orchestration remains active:
- `dispute-service` with SQLite persistence (`DISPUTE_DB_PATH`)
- Dispute lifecycle endpoints:
  - `POST /disputes/open`
  - `POST /disputes/:disputeId/assign`
  - `POST /disputes/:disputeId/resolve`
  - `GET /disputes/:disputeId`
  - `GET /disputes?status=OPEN|ASSIGNED|RESOLVED`
- Marketplace dispute integration:
  - `POST /listings/:listingId/dispute/open` (SETTLED listings only, within dispute window)
  - listing soft state: `underDispute`, `disputeId`, `disputeStatus`
  - publishes `DISPUTE_OPENED` audit event
- Inter-service authentication (optional hardening):
  - shared secret via `SERVICE_AUTH_TOKEN`
  - callers send `x-service-token: <SERVICE_AUTH_TOKEN>`
  - when enabled, protected write/ingest routes reject unauthorized requests with `401`

Milestone 10 reconciliation and auto-freeze remains active:
- `reconciliation-service` with SQLite persistence (`RECON_DB_PATH`)
- Reconciliation endpoints:
  - `POST /reconcile/run`
  - `GET /reconcile/latest`
  - `GET /reconcile/history`
  - `POST /freeze/unfreeze`
  - `GET /freeze/overrides`
- Reconciliation flow:
  - pulls certificate inventory from `certificate-service` (`GET /certificates`)
  - computes outstanding claims from `ACTIVE` + `LOCKED` certificates
  - compares against custody inventory (`CUSTODY_TOTAL_GRAM` or request override)
  - activates freeze state when abs mismatch breaches `RECON_MISMATCH_THRESHOLD_GRAM`
- Risk integration:
  - when freeze is triggered, reconciliation emits `POST /ingest/reconciliation-alert` to `risk-stream`
  - alert appears in `GET /risk/alerts`
- Marketplace enforcement:
  - if `RECONCILIATION_SERVICE_URL` is configured, marketplace write endpoints enforce freeze state
  - blocked while frozen: `POST /listings/create`, `POST /escrow/lock`, `POST /escrow/settle`
  - `POST /escrow/cancel` remains allowed for unwind
- Governance override:
  - manual unfreeze can be executed with actor+reason (`POST /freeze/unfreeze`)
  - override history is auditable (`GET /freeze/overrides`)

Milestone 9 risk dashboard + alerting remains active:
- `risk-stream` service with SQLite persistence (`RISK_DB_PATH`)
- Ingestion endpoints:
  - `POST /ingest/ledger-event`
  - `POST /ingest/listing-audit-event`
  - `POST /ingest/reconciliation-alert`
- Risk query endpoints:
  - `GET /risk/certificates/:certId`
  - `GET /risk/listings/:listingId`
  - `GET /risk/summary?limit=5`
  - `GET /risk/alerts?limit=20`
- Risk heuristics MVP:
  - transfer velocity spikes
  - wash-loop transfer patterns (back-and-forth owner movement)
  - repeated lock/cancel and timeout-driven cancellation patterns
- Alerting:
  - when risk score crosses `RISK_ALERT_THRESHOLD` (default 60)
  - persisted in `risk_alerts` table and streamed to `RISK_ALERT_WEBHOOK_URL` (optional)
- `ledger-adapter` and `marketplace-service` can publish events to risk-stream via `RISK_STREAM_URL`
- Web verifier now shows risk summaries and recent alerts

Milestone 6 marketplace hardening remains active:
- `marketplace-service` endpoints:
  - `GET /listings?status=OPEN|LOCKED|SETTLED|CANCELLED`
  - `POST /listings/create`
  - `GET /listings/:listingId/audit`
  - `GET /listings/:listingId`
  - `POST /escrow/lock`
  - `POST /escrow/settle`
  - `POST /escrow/cancel`
- `marketplace-service` now uses SQLite persistence (`MARKETPLACE_DB_PATH`) so data survives restart.
- Escrow operations (`lock/settle/cancel`) now require `Idempotency-Key` request header.
- Audit trail is stored per listing (`CREATED`, `LOCKED`, `SETTLED`, `CANCELLED`).
- Escrow orchestration to `certificate-service`:
  - `lock` moves certificate status to `LOCKED`
  - `settle` unlocks to `ACTIVE`, then transfers ownership
  - `cancel` on locked listing unlocks certificate back to `ACTIVE`
- Hardcoded private keys removed from runtime defaults:
  - `ISSUER_PRIVATE_KEY_HEX` must be set for `certificate-service`
  - `CHAIN_PRIVATE_KEY` must be set when `DGC_REGISTRY_ADDRESS` is enabled in `ledger-adapter`

## Milestone History (1 -> Current)

- Milestone 1: certificate issue/verify foundation
- Milestone 2: SQLite persistence + proof anchoring
- Milestone 3: transfer, split, status change, timeline flow
- Milestone 4: local-chain ledger integration
- Milestone 5: marketplace escrow flow
- Milestone 6: persistence hardening, idempotency, env key hardening
- Milestone 7: risk-stream scoring MVP
- Milestone 8: web-verifier risk view
- Milestone 9: risk summary + alerting
- Milestone 10: reconciliation + freeze enforcement
- Milestone 11: dispute service + marketplace dispute integration + verifier panels
- Milestone 12 (current): inter-service auth token + governance RBAC enforcement

## Run Milestone 12 On Localhost (With Local Chain)

If `pnpm` is not installed globally, use `corepack pnpm`.

```bash
corepack pnpm install
corepack pnpm -C packages/shared build
corepack pnpm -C contracts build
```

Start local chain (terminal 1):

```bash
corepack pnpm -C contracts dev
```

Deploy `DGCRegistry` (terminal 2):

```bash
corepack pnpm -C contracts deploy:local
# output: DGC_REGISTRY_ADDRESS=0x...
```

Prepare environment keys (terminal 3):

```bash
export ISSUER_PRIVATE_KEY_HEX="$(openssl rand -hex 32)"
export CHAIN_PRIVATE_KEY="<YOUR_LOCAL_CHAIN_PRIVATE_KEY>"
export SERVICE_AUTH_TOKEN="<SHARED_SERVICE_SECRET>"
```

Start ledger adapter with chain config (terminal 3):

```bash
PORT=4103 \
CHAIN_RPC_URL=http://127.0.0.1:8545 \
CHAIN_PRIVATE_KEY=<YOUR_LOCAL_CHAIN_PRIVATE_KEY> \
DGC_REGISTRY_ADDRESS=<PASTE_DEPLOYED_ADDRESS> \
RISK_STREAM_URL=http://127.0.0.1:4104 \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
corepack pnpm -C services/ledger-adapter dev
```

Start certificate service (terminal 4):

```bash
PORT=4101 \
ISSUER_PRIVATE_KEY_HEX=<YOUR_ISSUER_PRIVATE_KEY_HEX> \
CERT_DB_PATH=./data/certificate-service.db \
LEDGER_ADAPTER_URL=http://127.0.0.1:4103 \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
corepack pnpm -C services/certificate-service dev
```

Start marketplace service (terminal 5):

```bash
PORT=4102 \
CERTIFICATE_SERVICE_URL=http://127.0.0.1:4101 \
MARKETPLACE_DB_PATH=./data/marketplace-service.db \
RECONCILIATION_SERVICE_URL=http://127.0.0.1:4105 \
DISPUTE_SERVICE_URL=http://127.0.0.1:4106 \
RISK_STREAM_URL=http://127.0.0.1:4104 \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
corepack pnpm -C services/marketplace-service dev
```

Start risk-stream service (terminal 6):

```bash
PORT=4104 \
RISK_DB_PATH=./data/risk-stream.db \
RISK_ALERT_THRESHOLD=60 \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
# optional: push alerts to a webhook
# RISK_ALERT_WEBHOOK_URL=http://127.0.0.1:9999/alerts \
corepack pnpm -C services/risk-stream dev
```

Start reconciliation service (terminal 7):

```bash
PORT=4105 \
RECON_DB_PATH=./data/reconciliation-service.db \
CERTIFICATE_SERVICE_URL=http://127.0.0.1:4101 \
RISK_STREAM_URL=http://127.0.0.1:4104 \
CUSTODY_TOTAL_GRAM=0.0000 \
RECON_MISMATCH_THRESHOLD_GRAM=0.5000 \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
corepack pnpm -C services/reconciliation-service dev
```

Start dispute service (terminal 8):

```bash
PORT=4106 \
DISPUTE_DB_PATH=./data/dispute-service.db \
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN \
corepack pnpm -C services/dispute-service dev
```

Service URLs:
- `http://127.0.0.1:4101` (certificate-service)
- `http://127.0.0.1:4102` (marketplace-service)
- `http://127.0.0.1:4103` (ledger-adapter)
- `http://127.0.0.1:4104` (risk-stream)
- `http://127.0.0.1:4105` (reconciliation-service)
- `http://127.0.0.1:4106` (dispute-service)
- `http://127.0.0.1:8545` (Hardhat local chain)
- `http://127.0.0.1:3000` (web-verifier)

If `SERVICE_AUTH_TOKEN` is enabled, include this header for protected endpoints:

```bash
-H "x-service-token: $SERVICE_AUTH_TOKEN"
```

Governance-protected endpoints also require governance headers:

```bash
-H "x-governance-role: ops_admin"
-H "x-governance-actor: ops-admin"
```

Check chain connectivity from ledger-adapter:

```bash
curl http://127.0.0.1:4103/chain/status
```

Trigger reconciliation run:

```bash
curl -X POST http://127.0.0.1:4105/reconcile/run \
  -H "x-service-token: $SERVICE_AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"inventoryTotalGram":"10.0000"}'
```

Fetch latest reconciliation + freeze state:

```bash
curl http://127.0.0.1:4105/reconcile/latest \
  -H "x-service-token: $SERVICE_AUTH_TOKEN"
```

Manual unfreeze override with audit trail:

```bash
curl -X POST http://127.0.0.1:4105/freeze/unfreeze \
  -H "x-service-token: $SERVICE_AUTH_TOKEN" \
  -H "x-governance-role: ops_admin" \
  -H "x-governance-actor: ops-admin" \
  -H "content-type: application/json" \
  -d '{"actor":"ops-admin","reason":"false_positive"}'
```

List freeze override history:

```bash
curl http://127.0.0.1:4105/freeze/overrides?limit=10 \
  -H "x-service-token: $SERVICE_AUTH_TOKEN"
```

Issue certificate:

```bash
curl -X POST http://127.0.0.1:4101/certificates/issue \
  -H "content-type: application/json" \
  -d '{"owner":"0xabc999","amountGram":"1.0000","purity":"999.9","metadata":{"source":"localhost"}}'
```

Verify certificate:

```bash
curl -X POST http://127.0.0.1:4101/certificates/verify \
  -H "content-type: application/json" \
  -d '{"certId":"<CERT_ID_FROM_ISSUE_RESPONSE>"}'
```

Get anchored proof:

```bash
curl http://127.0.0.1:4103/proofs/<CERT_ID_FROM_ISSUE_RESPONSE>
```

Record event directly (returns `ledgerTxRef` when chain is enabled):

```bash
curl -X POST http://127.0.0.1:4103/events/record \
  -H "content-type: application/json" \
  -d '{"event":{"type":"STATUS_CHANGED","certId":"<CERT_ID>","occurredAt":"2026-02-11T03:00:00.000Z","status":"LOCKED"}}'
```

Transfer certificate:

```bash
curl -X POST http://127.0.0.1:4101/certificates/transfer \
  -H "content-type: application/json" \
  -d '{"certId":"<CERT_ID>","toOwner":"0xnewowner","price":"1000.0000"}'
```

Split certificate:

```bash
curl -X POST http://127.0.0.1:4101/certificates/split \
  -H "content-type: application/json" \
  -d '{"parentCertId":"<CERT_ID>","toOwner":"0xchildowner","amountChildGram":"0.2500"}'
```

Change status:

```bash
curl -X POST http://127.0.0.1:4101/certificates/status \
  -H "content-type: application/json" \
  -d '{"certId":"<CERT_ID>","status":"LOCKED"}'
```

Create listing:

```bash
curl -X POST http://127.0.0.1:4102/listings/create \
  -H "content-type: application/json" \
  -d '{"certId":"<CERT_ID>","seller":"0xabc999","askPrice":"1200.0000"}'
```

Lock escrow:

```bash
curl -X POST http://127.0.0.1:4102/escrow/lock \
  -H "idempotency-key: lock-001" \
  -H "content-type: application/json" \
  -d '{"listingId":"<LISTING_ID>","buyer":"0xbuyer001"}'
```

Settle escrow:

```bash
curl -X POST http://127.0.0.1:4102/escrow/settle \
  -H "idempotency-key: settle-001" \
  -H "content-type: application/json" \
  -d '{"listingId":"<LISTING_ID>","buyer":"0xbuyer001","settledPrice":"1195.0000"}'
```

Cancel escrow:

```bash
curl -X POST http://127.0.0.1:4102/escrow/cancel \
  -H "idempotency-key: cancel-001" \
  -H "content-type: application/json" \
  -d '{"listingId":"<LISTING_ID>","reason":"buyer_timeout"}'
```

List listings by status:

```bash
curl "http://127.0.0.1:4102/listings?status=OPEN"
```

Get listing audit trail:

```bash
curl http://127.0.0.1:4102/listings/<LISTING_ID>/audit
```

Get certificate risk profile:

```bash
curl http://127.0.0.1:4104/risk/certificates/<CERT_ID>
```

Get listing risk profile:

```bash
curl http://127.0.0.1:4104/risk/listings/<LISTING_ID>
```

Certificate status responses:

- Valid status values: `ACTIVE`, `LOCKED`, `REDEEMED`, `REVOKED`
- Allowed transitions:
  - `ACTIVE -> LOCKED | REDEEMED | REVOKED`
  - `LOCKED -> ACTIVE | REDEEMED | REVOKED`
  - `REDEEMED` and `REVOKED` are terminal (cannot transition again)

Success response (`200`):

```json
{
  "certificate": {
    "payload": {
      "certId": "DGC-...",
      "status": "LOCKED"
    }
  },
  "proofAnchorStatus": "ANCHORED",
  "proof": {
    "proofHash": "..."
  },
  "eventWriteStatus": "RECORDED"
}
```

Conflict response (`409`, invalid transition):

```json
{
  "error": "state_conflict",
  "message": "Transition REDEEMED -> ACTIVE is not allowed"
}
```

Not found response (`404`):

```json
{
  "error": "certificate_not_found"
}
```

Read timeline:

```bash
curl http://127.0.0.1:4101/certificates/<CERT_ID>/timeline
```

Run verifier app:

```bash
CERTIFICATE_SERVICE_URL=http://127.0.0.1:4101 corepack pnpm -C apps/web-verifier dev
```

OpenAPI:

```bash
curl http://127.0.0.1:4101/openapi.json
```

Run tests:

```bash
corepack pnpm -C contracts test
corepack pnpm -C services/marketplace-service test
corepack pnpm -C services/risk-stream test
corepack pnpm -C services/ledger-adapter test
corepack pnpm -C services/certificate-service test
```

## Security Notes

- Issuer keys should be managed with KMS/HSM in production.
- Public chain data should remain pseudonymous (no direct personal identity).
- Reconciliation should enforce:

```text
total_physical_gold_gram >= sum(outstanding_certificate_amount_gram)
```

## Current Scope

This is a portfolio prototype.  
It demonstrates cryptographic integrity, ownership auditability, and P2P flow design.  
It is not legal, financial, or regulatory advice.

## Maintainer

- GitHub: [@helllotrei](https://github.com/helllotrei)
