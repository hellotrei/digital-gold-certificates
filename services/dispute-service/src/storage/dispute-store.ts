import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DisputeRecord, DisputeStatus } from "@dgc/shared";

interface DisputeRow {
  dispute_json: string;
}

export interface DisputeStore {
  create(dispute: DisputeRecord): void;
  get(disputeId: string): DisputeRecord | null;
  list(status?: DisputeStatus): DisputeRecord[];
  update(dispute: DisputeRecord): void;
  close(): void;
}

export class SqliteDisputeStore implements DisputeStore {
  private readonly db: Database.Database;
  private readonly createStmt: Database.Statement<[string, string, string, string, string, string, string]>;
  private readonly getStmt: Database.Statement<[string], DisputeRow>;
  private readonly listAllStmt: Database.Statement<[], DisputeRow>;
  private readonly listByStatusStmt: Database.Statement<[string], DisputeRow>;
  private readonly updateStmt: Database.Statement<[string, string, string, string, string, string, string]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS disputes (
        dispute_id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        cert_id TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispute_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_disputes_status_updated
      ON disputes(status, updated_at DESC);
    `);

    this.createStmt = this.db.prepare(`
      INSERT INTO disputes (dispute_id, listing_id, cert_id, status, opened_at, updated_at, dispute_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.getStmt = this.db.prepare(`
      SELECT dispute_json
      FROM disputes
      WHERE dispute_id = ?
      LIMIT 1
    `) as Database.Statement<[string], DisputeRow>;

    this.listAllStmt = this.db.prepare(`
      SELECT dispute_json
      FROM disputes
      ORDER BY updated_at DESC
    `) as Database.Statement<[], DisputeRow>;

    this.listByStatusStmt = this.db.prepare(`
      SELECT dispute_json
      FROM disputes
      WHERE status = ?
      ORDER BY updated_at DESC
    `) as Database.Statement<[string], DisputeRow>;

    this.updateStmt = this.db.prepare(`
      UPDATE disputes
      SET listing_id = ?,
          cert_id = ?,
          status = ?,
          opened_at = ?,
          updated_at = ?,
          dispute_json = ?
      WHERE dispute_id = ?
    `);
  }

  create(dispute: DisputeRecord): void {
    this.createStmt.run(
      dispute.disputeId,
      dispute.listingId,
      dispute.certId,
      dispute.status,
      dispute.openedAt,
      dispute.resolvedAt || dispute.assignedAt || dispute.openedAt,
      JSON.stringify(dispute),
    );
  }

  get(disputeId: string): DisputeRecord | null {
    const row = this.getStmt.get(disputeId);
    if (!row) return null;
    return JSON.parse(row.dispute_json) as DisputeRecord;
  }

  list(status?: DisputeStatus): DisputeRecord[] {
    const rows = status ? this.listByStatusStmt.all(status) : this.listAllStmt.all();
    return rows.map((row) => JSON.parse(row.dispute_json) as DisputeRecord);
  }

  update(dispute: DisputeRecord): void {
    this.updateStmt.run(
      dispute.listingId,
      dispute.certId,
      dispute.status,
      dispute.openedAt,
      dispute.resolvedAt || dispute.assignedAt || dispute.openedAt,
      JSON.stringify(dispute),
      dispute.disputeId,
    );
  }

  close(): void {
    this.db.close();
  }
}
