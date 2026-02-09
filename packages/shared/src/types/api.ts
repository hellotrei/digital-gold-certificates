import type { SignedCertificate } from "./certificate.js";

export interface IssueCertificateRequest {
  owner: string;
  amountGram: string;
  purity: string;
  metadata?: Record<string, unknown>;
}

export interface IssueCertificateResponse {
  certificate: SignedCertificate;
}

export interface VerifyCertificateRequest {
  certId?: string;
  certificate?: SignedCertificate;
}

export interface VerifyCertificateResponse {
  certId: string;
  valid: boolean;
  hashMatches: boolean;
  signatureValid: boolean;
  status: string;
}
