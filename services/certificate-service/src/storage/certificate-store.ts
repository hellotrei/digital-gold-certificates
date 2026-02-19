import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CertificateStatus, SignedCertificate } from "@dgc/shared";

export interface CertificateStore {
  put(certificate: SignedCertificate): void;
  get(certId: string): SignedCertificate | null;
  list(status?: CertificateStatus): SignedCertificate[];
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
  private readonly listAllStmt: Database.Statement<[], Row>;

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

    this.listAllStmt = this.db.prepare(`
      SELECT cert_id, certificate_json
      FROM certificates
      ORDER BY cert_id ASC
    `) as Database.Statement<[], Row>;
  }

  put(certificate: SignedCertificate): void {
    this.putStmt.run(certificate.payload.certId, JSON.stringify(certificate));
  }

  get(certId: string): SignedCertificate | null {
    const row = this.getStmt.get(certId);
    if (!row) return null;
    return JSON.parse(row.certificate_json) as SignedCertificate;
  }

  list(status?: CertificateStatus): SignedCertificate[] {
    const rows = this.listAllStmt.all();
    const certificates = rows.map((row) => JSON.parse(row.certificate_json) as SignedCertificate);
    if (!status) return certificates;
    return certificates.filter((certificate) => certificate.payload.status === status);
  }

  close(): void {
    this.db.close();
  }
}
