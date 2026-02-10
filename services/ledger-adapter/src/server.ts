import Fastify from "fastify";
import {
  canonicalJson,
  sha256Hex,
  type AnchorProofRequest,
  type AnchorProofResponse,
  type ProofAnchorRecord,
} from "@dgc/shared";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAnchorProofRequest(body: unknown): body is AnchorProofRequest {
  if (!isObject(body)) return false;
  return (
    isNonEmptyString(body.certId) &&
    isNonEmptyString(body.payloadHash) &&
    isNonEmptyString(body.occurredAt)
  );
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  const proofStore = new Map<string, ProofAnchorRecord>();

  app.get("/health", async () => ({ ok: true, service: "ledger-adapter" }));

  app.post("/proofs/anchor", async (req, reply) => {
    if (!isAnchorProofRequest(req.body)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId, payloadHash, occurredAt",
      });
    }

    const body = req.body;
    const anchoredAt = new Date().toISOString();
    const proofHash = sha256Hex(
      canonicalJson({
        certId: body.certId,
        payloadHash: body.payloadHash,
        occurredAt: body.occurredAt,
        anchoredAt,
      }),
    );

    const proof: ProofAnchorRecord = {
      certId: body.certId,
      payloadHash: body.payloadHash,
      proofHash,
      anchoredAt,
    };
    proofStore.set(body.certId, proof);

    const response: AnchorProofResponse = { proof };
    return reply.code(201).send(response);
  });

  app.get("/proofs/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    const proof = proofStore.get(params.certId);
    if (!proof) {
      return reply.code(404).send({ error: "proof_not_found" });
    }

    return { proof };
  });

  return app;
}
