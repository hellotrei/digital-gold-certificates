import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { FreezeOverrideRecord, FreezeState, ReconciliationRun } from "@dgc/shared";

interface RunRow {
  run_json: string;
}

interface FreezeRow {
  active: number;
  reason: string | null;
  updated_at: string;
  last_run_id: string | null;
}

interface FreezeOverrideRow {
  override_json: string;
}

export interface ReconciliationStore {
  insertRun(run: ReconciliationRun): void;
  getLatestRun(): ReconciliationRun | null;
  listRuns(limit: number): ReconciliationRun[];
  setFreezeState(state: FreezeState): void;
  getFreezeState(): FreezeState;
  insertFreezeOverride(overrideRecord: FreezeOverrideRecord): void;
  listFreezeOverrides(limit: number): FreezeOverrideRecord[];
  close(): void;
}

export class SqliteReconciliationStore implements ReconciliationStore {
  private readonly db: Database.Database;
  private readonly insertRunStmt: Database.Statement<[string, string, string, string, string, string, string, number, number, number, number, string]>;
  private readonly getLatestRunStmt: Database.Statement<[], RunRow>;
  private readonly listRunsStmt: Database.Statement<[number], RunRow>;
  private readonly upsertFreezeStateStmt: Database.Statement<[number, string | null, string, string | null]>;
  private readonly getFreezeStateStmt: Database.Statement<[], FreezeRow>;
  private readonly insertFreezeOverrideStmt: Database.Statement<
    [string, string, string, string, number, number, string, string | null, string]
  >;
  private readonly listFreezeOverridesStmt: Database.Statement<[number], FreezeOverrideRow>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        custody_total_gram TEXT NOT NULL,
        outstanding_total_gram TEXT NOT NULL,
        mismatch_gram TEXT NOT NULL,
        abs_mismatch_gram TEXT NOT NULL,
        threshold_gram TEXT NOT NULL,
        freeze_triggered INTEGER NOT NULL,
        certificates_evaluated INTEGER NOT NULL,
        active_certificates INTEGER NOT NULL,
        locked_certificates INTEGER NOT NULL,
        run_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_created_at
      ON reconciliation_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS reconciliation_freeze_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        active INTEGER NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL,
        last_run_id TEXT
      );

      CREATE TABLE IF NOT EXISTS reconciliation_freeze_overrides (
        override_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        previous_active INTEGER NOT NULL,
        next_active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        override_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reconciliation_freeze_overrides_created_at
      ON reconciliation_freeze_overrides(created_at DESC);
    `);

    this.insertRunStmt = this.db.prepare(`
      INSERT INTO reconciliation_runs (
        run_id,
        created_at,
        custody_total_gram,
        outstanding_total_gram,
        mismatch_gram,
        abs_mismatch_gram,
        threshold_gram,
        freeze_triggered,
        certificates_evaluated,
        active_certificates,
        locked_certificates,
        run_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getLatestRunStmt = this.db.prepare(`
      SELECT run_json
      FROM reconciliation_runs
      ORDER BY created_at DESC
      LIMIT 1
    `) as Database.Statement<[], RunRow>;

    this.listRunsStmt = this.db.prepare(`
      SELECT run_json
      FROM reconciliation_runs
      ORDER BY created_at DESC
      LIMIT ?
    `) as Database.Statement<[number], RunRow>;

    this.upsertFreezeStateStmt = this.db.prepare(`
      INSERT INTO reconciliation_freeze_state (singleton_id, active, reason, updated_at, last_run_id)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        active = excluded.active,
        reason = excluded.reason,
        updated_at = excluded.updated_at,
        last_run_id = excluded.last_run_id
    `);

    this.getFreezeStateStmt = this.db.prepare(`
      SELECT active, reason, updated_at, last_run_id
      FROM reconciliation_freeze_state
      WHERE singleton_id = 1
      LIMIT 1
    `) as Database.Statement<[], FreezeRow>;

    this.insertFreezeOverrideStmt = this.db.prepare(`
      INSERT INTO reconciliation_freeze_overrides (
        override_id,
        action,
        actor,
        reason,
        previous_active,
        next_active,
        created_at,
        run_id,
        override_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.listFreezeOverridesStmt = this.db.prepare(`
      SELECT override_json
      FROM reconciliation_freeze_overrides
      ORDER BY created_at DESC
      LIMIT ?
    `) as Database.Statement<[number], FreezeOverrideRow>;

    const existing = this.getFreezeStateStmt.get();
    if (!existing) {
      const now = new Date().toISOString();
      this.upsertFreezeStateStmt.run(0, null, now, null);
    }
  }

  insertRun(run: ReconciliationRun): void {
    this.insertRunStmt.run(
      run.runId,
      run.createdAt,
      run.custodyTotalGram,
      run.outstandingTotalGram,
      run.mismatchGram,
      run.absMismatchGram,
      run.thresholdGram,
      run.freezeTriggered ? 1 : 0,
      run.certificatesEvaluated,
      run.activeCertificates,
      run.lockedCertificates,
      JSON.stringify(run),
    );
  }

  getLatestRun(): ReconciliationRun | null {
    const row = this.getLatestRunStmt.get();
    if (!row) return null;
    return JSON.parse(row.run_json) as ReconciliationRun;
  }

  listRuns(limit: number): ReconciliationRun[] {
    const rows = this.listRunsStmt.all(limit);
    return rows.map((row) => JSON.parse(row.run_json) as ReconciliationRun);
  }

  setFreezeState(state: FreezeState): void {
    this.upsertFreezeStateStmt.run(
      state.active ? 1 : 0,
      state.reason || null,
      state.updatedAt,
      state.lastRunId || null,
    );
  }

  getFreezeState(): FreezeState {
    const row = this.getFreezeStateStmt.get();
    if (!row) {
      return {
        active: false,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      active: row.active === 1,
      reason: row.reason || undefined,
      updatedAt: row.updated_at,
      lastRunId: row.last_run_id || undefined,
    };
  }

  insertFreezeOverride(overrideRecord: FreezeOverrideRecord): void {
    this.insertFreezeOverrideStmt.run(
      overrideRecord.overrideId,
      overrideRecord.action,
      overrideRecord.actor,
      overrideRecord.reason,
      overrideRecord.previousActive ? 1 : 0,
      overrideRecord.nextActive ? 1 : 0,
      overrideRecord.createdAt,
      overrideRecord.runId || null,
      JSON.stringify(overrideRecord),
    );
  }

  listFreezeOverrides(limit: number): FreezeOverrideRecord[] {
    const rows = this.listFreezeOverridesStmt.all(limit);
    return rows.map((row) => JSON.parse(row.override_json) as FreezeOverrideRecord);
  }

  close(): void {
    this.db.close();
  }
}
