import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  type AnchorProofResponse,
  type CertificateStatus,
  canonicalJson,
  type ChangeCertificateStatusRequest,
  type ChangeCertificateStatusResponse,
  type GetTimelineResponse,
  type IssueCertificateRequest,
  type IssueCertificateResponse,
  type LedgerEvent,
  type ProofAnchorRecord,
  type SignedCertificate,
  type SplitCertificateRequest,
  type SplitCertificateResponse,
  type TransferCertificateRequest,
  type TransferCertificateResponse,
  type VerifyCertificateRequest,
  type VerifyCertificateResponse,
  publicKeyFromPrivateKeyHex,
  sha256Hex,
  signHex,
  verifyHex,
} from "@dgc/shared";
import { buildOpenApiSpec } from "./openapi.js";
import {
  type CertificateStore,
  SqliteCertificateStore,
} from "./storage/certificate-store.js";

const DEFAULT_DB_PATH = "data/certificate-service.db";
const AMOUNT_SCALE = 10000n;

const ALLOWED_STATUS_TRANSITIONS: Record<CertificateStatus, CertificateStatus[]> = {
  ACTIVE: ["LOCKED", "REDEEMED", "REVOKED"],
  LOCKED: ["ACTIVE", "REDEEMED", "REVOKED"],
  REDEEMED: [],
  REVOKED: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAmountGram(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d{1,4})?$/.test(value);
}

function isPurity(value: unknown): value is string {
  return typeof value === "string" && /^\d{3}\.\d$/.test(value);
}

function isCertificateStatus(value: unknown): value is CertificateStatus {
  return value === "ACTIVE" || value === "LOCKED" || value === "REDEEMED" || value === "REVOKED";
}

function parseAmountGramScaled(value: string): bigint {
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = BigInt(wholeRaw);
  const fraction = BigInt((fractionRaw + "0000").slice(0, 4));
  return whole * AMOUNT_SCALE + fraction;
}

function formatAmountGram(scaled: bigint): string {
  const whole = scaled / AMOUNT_SCALE;
  const fraction = scaled % AMOUNT_SCALE;
  return `${whole.toString()}.${fraction.toString().padStart(4, "0")}`;
}

function parseIssueRequest(body: unknown): IssueCertificateRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.owner)) return null;
  if (!isAmountGram(body.amountGram)) return null;
  if (!isPurity(body.purity)) return null;
  if (body.metadata !== undefined && !isObject(body.metadata)) return null;
  return {
    owner: body.owner,
    amountGram: body.amountGram,
    purity: body.purity,
    metadata: body.metadata,
  };
}

function parseVerifyRequest(body: unknown): VerifyCertificateRequest | null {
  if (!isObject(body)) return null;
  if (body.certId !== undefined && !isNonEmptyString(body.certId)) return null;
  if (body.certificate !== undefined && !isObject(body.certificate)) return null;
  return {
    certId: body.certId,
    certificate: body.certificate as SignedCertificate | undefined,
  };
}

function parseTransferRequest(body: unknown): TransferCertificateRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.certId)) return null;
  if (!isNonEmptyString(body.toOwner)) return null;
  if (body.price !== undefined && !isAmountGram(body.price)) return null;
  return {
    certId: body.certId,
    toOwner: body.toOwner,
    price: body.price,
  };
}

function parseSplitRequest(body: unknown): SplitCertificateRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.parentCertId)) return null;
  if (!isNonEmptyString(body.toOwner)) return null;
  if (!isAmountGram(body.amountChildGram)) return null;
  if (body.price !== undefined && !isAmountGram(body.price)) return null;
  return {
    parentCertId: body.parentCertId,
    toOwner: body.toOwner,
    amountChildGram: body.amountChildGram,
    price: body.price,
  };
}

function parseStatusRequest(body: unknown): ChangeCertificateStatusRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.certId)) return null;
  if (!isCertificateStatus(body.status)) return null;
  return {
    certId: body.certId,
    status: body.status,
  };
}

function certIdNow(): string {
  return `DGC-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
}

interface BuildServerOptions {
  certificateStore?: CertificateStore;
  dbPath?: string;
  issuerPrivateKeyHex?: string;
  ledgerAdapterUrl?: string;
  serviceBaseUrl?: string;
}

async function signCertificate(
  payload: SignedCertificate["payload"],
  issuerPrivateKeyHex: string,
): Promise<SignedCertificate> {
  const payloadHash = sha256Hex(canonicalJson(payload));
  const signature = await signHex(payloadHash, issuerPrivateKeyHex);
  return {
    payload,
    payloadHash,
    signature,
  };
}

async function tryAnchorProof(
  ledgerAdapterUrl: string | undefined,
  certId: string,
  payloadHash: string,
  occurredAt: string,
): Promise<{ proofAnchorStatus: "ANCHORED" | "SKIPPED" | "FAILED"; proof?: ProofAnchorRecord }> {
  if (!ledgerAdapterUrl) {
    return { proofAnchorStatus: "SKIPPED" };
  }

  try {
    const response = await fetch(`${ledgerAdapterUrl.replace(/\/$/, "")}/proofs/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certId, payloadHash, occurredAt }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { proofAnchorStatus: "FAILED" };
    }

    const json = (await response.json()) as AnchorProofResponse;
    return { proofAnchorStatus: "ANCHORED", proof: json.proof };
  } catch {
    return { proofAnchorStatus: "FAILED" };
  }
}

async function tryRecordLedgerEvent(
  ledgerAdapterUrl: string | undefined,
  event: LedgerEvent,
): Promise<"RECORDED" | "SKIPPED" | "FAILED"> {
  if (!ledgerAdapterUrl) {
    return "SKIPPED";
  }

  try {
    const response = await fetch(`${ledgerAdapterUrl.replace(/\/$/, "")}/events/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? "RECORDED" : "FAILED";
  } catch {
    return "FAILED";
  }
}

function combineProofStatus(
  statuses: Array<"ANCHORED" | "SKIPPED" | "FAILED">,
): "ANCHORED" | "SKIPPED" | "FAILED" {
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("ANCHORED")) return "ANCHORED";
  return "SKIPPED";
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const certStore =
    options.certificateStore ||
    new SqliteCertificateStore(options.dbPath || process.env.CERT_DB_PATH || DEFAULT_DB_PATH);
  const ownStore = !options.certificateStore;
  const issuerPrivateKeyHex =
    options.issuerPrivateKeyHex ||
    process.env.ISSUER_PRIVATE_KEY_HEX;
  if (!issuerPrivateKeyHex) {
    throw new Error(
      "ISSUER_PRIVATE_KEY_HEX is required (or pass issuerPrivateKeyHex in buildServer options)",
    );
  }
  const issuerPublicKeyHex = await publicKeyFromPrivateKeyHex(issuerPrivateKeyHex);
  const ledgerAdapterUrl = options.ledgerAdapterUrl ?? process.env.LEDGER_ADAPTER_URL;
  const serviceBaseUrl =
    options.serviceBaseUrl ||
    process.env.SERVICE_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 4101}`;

  app.get("/health", async () => ({ ok: true, service: "certificate-service" }));
  app.get("/openapi.json", async () => buildOpenApiSpec(serviceBaseUrl));

  app.post("/certificates/issue", async (req, reply) => {
    const parsed = parseIssueRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected owner, amountGram, purity and optional metadata object",
      });
    }

    const payload = {
      certId: certIdNow(),
      issuer: issuerPublicKeyHex,
      owner: parsed.owner,
      amountGram: parsed.amountGram,
      purity: parsed.purity,
      issuedAt: new Date().toISOString(),
      status: "ACTIVE" as const,
      metadata: parsed.metadata,
    };

    const certificate = await signCertificate(payload, issuerPrivateKeyHex);
    certStore.put(certificate);

    const proofResult = await tryAnchorProof(
      ledgerAdapterUrl,
      certificate.payload.certId,
      certificate.payloadHash,
      certificate.payload.issuedAt,
    );

    const eventWriteStatus = await tryRecordLedgerEvent(ledgerAdapterUrl, {
      type: "ISSUED",
      certId: certificate.payload.certId,
      occurredAt: certificate.payload.issuedAt,
      proofHash: proofResult.proof?.proofHash,
      owner: certificate.payload.owner,
      amountGram: certificate.payload.amountGram,
      purity: certificate.payload.purity,
    });

    const response: IssueCertificateResponse = {
      certificate,
      proofAnchorStatus: proofResult.proofAnchorStatus,
      proof: proofResult.proof,
      eventWriteStatus,
    };

    return reply.code(201).send(response);
  });

  app.post("/certificates/transfer", async (req, reply) => {
    const parsed = parseTransferRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId, toOwner, and optional price",
      });
    }

    const current = certStore.get(parsed.certId);
    if (!current) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }
    if (current.payload.status !== "ACTIVE") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only ACTIVE certificates can be transferred",
      });
    }

    const previousOwner = current.payload.owner;
    const updatedPayload = {
      ...current.payload,
      owner: parsed.toOwner,
      metadata: {
        ...(current.payload.metadata || {}),
        lastTransferAt: new Date().toISOString(),
        ...(parsed.price ? { lastTransferPrice: parsed.price } : {}),
      },
    };

    const certificate = await signCertificate(updatedPayload, issuerPrivateKeyHex);
    certStore.put(certificate);

    const proofResult = await tryAnchorProof(
      ledgerAdapterUrl,
      certificate.payload.certId,
      certificate.payloadHash,
      new Date().toISOString(),
    );

    const eventWriteStatus = await tryRecordLedgerEvent(ledgerAdapterUrl, {
      type: "TRANSFER",
      certId: certificate.payload.certId,
      occurredAt: new Date().toISOString(),
      proofHash: proofResult.proof?.proofHash,
      from: previousOwner,
      to: parsed.toOwner,
      amountGram: certificate.payload.amountGram,
      price: parsed.price,
    });

    const response: TransferCertificateResponse = {
      certificate,
      proofAnchorStatus: proofResult.proofAnchorStatus,
      proof: proofResult.proof,
      eventWriteStatus,
    };

    return response;
  });

  app.post("/certificates/split", async (req, reply) => {
    const parsed = parseSplitRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected parentCertId, toOwner, amountChildGram, and optional price",
      });
    }

    const parentCurrent = certStore.get(parsed.parentCertId);
    if (!parentCurrent) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }
    if (parentCurrent.payload.status !== "ACTIVE") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only ACTIVE certificates can be split",
      });
    }

    const parentScaled = parseAmountGramScaled(parentCurrent.payload.amountGram);
    const childScaled = parseAmountGramScaled(parsed.amountChildGram);

    if (childScaled <= 0n || childScaled >= parentScaled) {
      return reply.code(400).send({
        error: "invalid_amount",
        message: "amountChildGram must be greater than 0 and less than parent amount",
      });
    }

    const nowIso = new Date().toISOString();

    const parentPayload = {
      ...parentCurrent.payload,
      amountGram: formatAmountGram(parentScaled - childScaled),
      metadata: {
        ...(parentCurrent.payload.metadata || {}),
        lastSplitAt: nowIso,
      },
    };

    const childPayload = {
      certId: certIdNow(),
      issuer: parentCurrent.payload.issuer,
      owner: parsed.toOwner,
      amountGram: formatAmountGram(childScaled),
      purity: parentCurrent.payload.purity,
      issuedAt: nowIso,
      status: "ACTIVE" as const,
      metadata: {
        parentCertId: parentCurrent.payload.certId,
        ...(parsed.price ? { splitPrice: parsed.price } : {}),
      },
    };

    const [parentCertificate, childCertificate] = await Promise.all([
      signCertificate(parentPayload, issuerPrivateKeyHex),
      signCertificate(childPayload, issuerPrivateKeyHex),
    ]);

    certStore.put(parentCertificate);
    certStore.put(childCertificate);

    const [parentProof, childProof] = await Promise.all([
      tryAnchorProof(
        ledgerAdapterUrl,
        parentCertificate.payload.certId,
        parentCertificate.payloadHash,
        nowIso,
      ),
      tryAnchorProof(
        ledgerAdapterUrl,
        childCertificate.payload.certId,
        childCertificate.payloadHash,
        nowIso,
      ),
    ]);

    const eventWriteStatus = await tryRecordLedgerEvent(ledgerAdapterUrl, {
      type: "SPLIT",
      certId: parentCertificate.payload.certId,
      occurredAt: nowIso,
      proofHash: childProof.proof?.proofHash,
      parentCertId: parentCertificate.payload.certId,
      childCertId: childCertificate.payload.certId,
      from: parentCurrent.payload.owner,
      to: childCertificate.payload.owner,
      amountChildGram: childCertificate.payload.amountGram,
    });

    const response: SplitCertificateResponse = {
      parentCertificate,
      childCertificate,
      proofAnchorStatus: combineProofStatus([
        parentProof.proofAnchorStatus,
        childProof.proofAnchorStatus,
      ]),
      parentProof: parentProof.proof,
      childProof: childProof.proof,
      eventWriteStatus,
    };

    return response;
  });

  app.post("/certificates/status", async (req, reply) => {
    const parsed = parseStatusRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId and valid status",
      });
    }

    const current = certStore.get(parsed.certId);
    if (!current) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[current.payload.status];
    if (!allowed.includes(parsed.status)) {
      return reply.code(409).send({
        error: "state_conflict",
        message: `Transition ${current.payload.status} -> ${parsed.status} is not allowed`,
      });
    }

    const occurredAt = new Date().toISOString();
    const updatedPayload = {
      ...current.payload,
      status: parsed.status,
      metadata: {
        ...(current.payload.metadata || {}),
        lastStatusChangeAt: occurredAt,
      },
    };

    const certificate = await signCertificate(updatedPayload, issuerPrivateKeyHex);
    certStore.put(certificate);

    const proofResult = await tryAnchorProof(
      ledgerAdapterUrl,
      certificate.payload.certId,
      certificate.payloadHash,
      occurredAt,
    );

    const eventWriteStatus = await tryRecordLedgerEvent(ledgerAdapterUrl, {
      type: "STATUS_CHANGED",
      certId: certificate.payload.certId,
      occurredAt,
      proofHash: proofResult.proof?.proofHash,
      status: parsed.status,
    });

    const response: ChangeCertificateStatusResponse = {
      certificate,
      proofAnchorStatus: proofResult.proofAnchorStatus,
      proof: proofResult.proof,
      eventWriteStatus,
    };

    return response;
  });

  app.get("/certificates/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }
    const certificate = certStore.get(params.certId);
    if (!certificate) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }
    return { certificate };
  });

  app.get("/certificates/:certId/timeline", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    if (!ledgerAdapterUrl) {
      return reply.code(503).send({
        error: "ledger_adapter_not_configured",
        certId: params.certId,
      });
    }

    try {
      const response = await fetch(
        `${ledgerAdapterUrl.replace(/\/$/, "")}/events/${encodeURIComponent(params.certId)}`,
        { signal: AbortSignal.timeout(5000) },
      );

      if (response.status === 404) {
        const empty: GetTimelineResponse = {
          certId: params.certId,
          events: [],
        };
        return empty;
      }

      if (!response.ok) {
        return reply.code(502).send({
          error: "ledger_adapter_error",
          statusCode: response.status,
        });
      }

      const timeline = (await response.json()) as GetTimelineResponse;
      return timeline;
    } catch {
      return reply.code(502).send({
        error: "ledger_adapter_unreachable",
      });
    }
  });

  app.post("/certificates/verify", async (req, reply) => {
    const parsed = parseVerifyRequest(req.body);
    if (!parsed || (!parsed.certId && !parsed.certificate)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Provide certId or certificate",
      });
    }

    const certificate = parsed.certificate || certStore.get(parsed.certId || "");
    if (!certificate) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }

    const recalculatedHash = sha256Hex(canonicalJson(certificate.payload));
    const hashMatches = recalculatedHash === certificate.payloadHash;

    let signatureValid = false;
    if (hashMatches) {
      try {
        signatureValid = await verifyHex(
          certificate.payloadHash,
          certificate.signature,
          certificate.payload.issuer,
        );
      } catch {
        signatureValid = false;
      }
    }

    const response: VerifyCertificateResponse = {
      certId: certificate.payload.certId,
      valid: hashMatches && signatureValid,
      hashMatches,
      signatureValid,
      status: certificate.payload.status,
    };

    return reply.send(response);
  });

  app.addHook("onClose", async () => {
    if (ownStore) {
      certStore.close();
    }
  });

  return app;
}
