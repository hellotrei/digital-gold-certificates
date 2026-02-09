export type CertificateStatus = "ACTIVE" | "LOCKED" | "REDEEMED" | "REVOKED";

export interface GoldCertificate {
  certId: string;           // deterministic ID (e.g., sha256(payload))
  issuer: string;           // issuer identifier (public key fingerprint / DID, etc.)
  owner: string;            // owner wallet address / account reference
  amountGram: string;       // decimal-safe string ("1.2345")
  purity: string;           // e.g. "999.9"
  issuedAt: string;         // ISO date
  status: CertificateStatus;
  metadata?: Record<string, unknown>;
}

export interface SignedCertificate {
  payload: GoldCertificate;
  payloadHash: string;      // sha256Hex(canonicalJson(payload))
  signature: string;        // Ed25519 signature over payloadHash (hex)
}
