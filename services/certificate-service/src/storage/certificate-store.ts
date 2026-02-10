import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { SignedCertificate } from "@dgc/shared";

export interface CertificateStore {
  put(certificate: SignedCertificate): void;
  get(certId: string): SignedCertificate | null;
  close(): void;
}

interface Row {
  cert_id: string;
  certificate_json: string;
}

export class SqliteCertificateStore implements CertificateStore {
  private readonly db: Database.Database;
  private readonly putStmt: Database.Statement<[string, string]>;
  private readonly getStmt: Database.Statement<[string], Row>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS certificates (
        cert_id TEXT PRIMARY KEY,
        certificate_json TEXT NOT NULL
      );
    `);

    this.putStmt = this.db.prepare(`
      INSERT INTO certificates (cert_id, certificate_json)
      VALUES (?, ?)
      ON CONFLICT(cert_id) DO UPDATE SET
        certificate_json = excluded.certificate_json
    `);

    this.getStmt = this.db.prepare(`
      SELECT cert_id, certificate_json
      FROM certificates
      WHERE cert_id = ?
      LIMIT 1
    `) as Database.Statement<[string], Row>;
  }

  put(certificate: SignedCertificate): void {
    this.putStmt.run(certificate.payload.certId, JSON.stringify(certificate));
  }

  get(certId: string): SignedCertificate | null {
    const row = this.getStmt.get(certId);
    if (!row) return null;
    return JSON.parse(row.certificate_json) as SignedCertificate;
  }

  close(): void {
    this.db.close();
  }
}
