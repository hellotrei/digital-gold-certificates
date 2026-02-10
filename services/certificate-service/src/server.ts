import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  type AnchorProofResponse,
  canonicalJson,
  type ProofAnchorRecord,
  publicKeyFromPrivateKeyHex,
  sha256Hex,
  signHex,
  verifyHex,
  type IssueCertificateRequest,
  type IssueCertificateResponse,
  type SignedCertificate,
  type VerifyCertificateRequest,
  type VerifyCertificateResponse,
} from "@dgc/shared";
import { buildOpenApiSpec } from "./openapi.js";
import {
  type CertificateStore,
  SqliteCertificateStore,
} from "./storage/certificate-store.js";

const DEFAULT_ISSUER_PRIVATE_KEY_HEX =
  "1f1e1d1c1b1a19181716151413121110ffeeddbbccaa99887766554433221100";
const DEFAULT_DB_PATH = "data/certificate-service.db";

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

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const certStore =
    options.certificateStore ||
    new SqliteCertificateStore(options.dbPath || process.env.CERT_DB_PATH || DEFAULT_DB_PATH);
  const ownStore = !options.certificateStore;
  const issuerPrivateKeyHex =
    options.issuerPrivateKeyHex ||
    process.env.ISSUER_PRIVATE_KEY_HEX ||
    DEFAULT_ISSUER_PRIVATE_KEY_HEX;
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
    const payloadHash = sha256Hex(canonicalJson(payload));
    const signature = await signHex(payloadHash, issuerPrivateKeyHex);

    const certificate: SignedCertificate = {
      payload,
      payloadHash,
      signature,
    };
    certStore.put(certificate);

    const proofResult = await tryAnchorProof(
      ledgerAdapterUrl,
      certificate.payload.certId,
      certificate.payloadHash,
      certificate.payload.issuedAt,
    );

    const response: IssueCertificateResponse = {
      certificate,
      proofAnchorStatus: proofResult.proofAnchorStatus,
      proof: proofResult.proof,
    };
    return reply.code(201).send(response);
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
