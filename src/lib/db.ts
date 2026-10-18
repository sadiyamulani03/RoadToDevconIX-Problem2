import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  MarketRecordSchema,
  type GenerationMode,
  type MarketData,
  type MarketRecord,
  type MarketStatus,
  type SemanticIssue,
} from "./domain/schema";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  discarded_at TEXT,
  generation_mode TEXT NOT NULL CHECK (generation_mode IN ('llm', 'heuristic')),
  generation_provider TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  market_json TEXT NOT NULL,
  issues_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markets_created_at ON markets (created_at DESC);
`;

interface MarketRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  discarded_at: string | null;
  generation_mode: string;
  generation_provider: string;
  revision: number;
  market_json: string;
  issues_json: string;
}

export class MarketStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MarketStoreError";
  }
}

export interface CreateMarketParams {
  id: string;
  market: MarketData;
  issues: SemanticIssue[];
  generationMode: GenerationMode;
  generationProvider: string;
  now: Date;
}

/**
 * Thin SQLite persistence layer. Every value read back from the database is
 * re-validated with the Zod record schema, because the database is a trust
 * boundary too.
 */
export class MarketStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    if (filename === ":memory:") {
      this.db = new Database(":memory:");
    } else {
      const absolute = resolve(filename);
      mkdirSync(dirname(absolute), { recursive: true });
      this.db = new Database(absolute);
    }
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  create(params: CreateMarketParams): MarketRecord {
    const createdAt = params.now.toISOString();
    const market: MarketData = { ...params.market, status: "draft" };
    const record: MarketRecord = {
      id: params.id,
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      approvedAt: null,
      discardedAt: null,
      generationMode: params.generationMode,
      generationProvider: params.generationProvider,
      sourceVerification: "syntactic-only",
      revision: 1,
      market,
      semanticIssues: params.issues,
    };
    const validated = MarketRecordSchema.parse(record);
    this.db
      .prepare(
        `INSERT INTO markets (id, status, created_at, updated_at, approved_at, discarded_at,
           generation_mode, generation_provider, revision, market_json, issues_json)
         VALUES (@id, @status, @createdAt, @updatedAt, @approvedAt, @discardedAt,
           @generationMode, @generationProvider, @revision, @marketJson, @issuesJson)`,
      )
      .run({
        id: validated.id,
        status: validated.status,
        createdAt: validated.createdAt,
        updatedAt: validated.updatedAt,
        approvedAt: validated.approvedAt,
        discardedAt: validated.discardedAt,
        generationMode: validated.generationMode,
        generationProvider: validated.generationProvider,
        revision: validated.revision,
        marketJson: JSON.stringify(validated.market),
        issuesJson: JSON.stringify(validated.semanticIssues),
      });
    return validated;
  }

  get(id: string): MarketRecord | null {
    const row = this.db.prepare(`SELECT * FROM markets WHERE id = ?`).get(id) as
      | MarketRow
      | undefined;
    return row ? this.toRecord(row) : null;
  }

  list(limit = 50): MarketRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM markets ORDER BY created_at DESC, id ASC LIMIT ?`)
      .all(bounded) as MarketRow[];
    return rows.map((row) => this.toRecord(row));
  }

  updateMarket(id: string, market: MarketData, issues: SemanticIssue[], now: Date): MarketRecord {
    return this.withTransaction(() => {
      const existing = this.get(id);
      if (!existing) throw new MarketStoreError(`market ${id} not found`);
      const record: MarketRecord = MarketRecordSchema.parse({
        ...existing,
        updatedAt: now.toISOString(),
        revision: existing.revision + 1,
        market: { ...market, status: existing.status },
        semanticIssues: issues,
      });
      this.writeRecord(record);
      return record;
    });
  }

  updateStatus(
    id: string,
    status: MarketStatus,
    now: Date,
    issues?: SemanticIssue[],
  ): MarketRecord {
    return this.withTransaction(() => {
      const existing = this.get(id);
      if (!existing) throw new MarketStoreError(`market ${id} not found`);
      const timestamp = now.toISOString();
      const record: MarketRecord = MarketRecordSchema.parse({
        ...existing,
        status,
        updatedAt: timestamp,
        approvedAt: status === "approved" ? timestamp : existing.approvedAt,
        discardedAt: status === "discarded" ? timestamp : existing.discardedAt,
        semanticIssues: issues ?? existing.semanticIssues,
        market: { ...existing.market, status },
      });
      this.writeRecord(record);
      return record;
    });
  }

  private withTransaction<T>(operation: () => T): T {
    const run = this.db.transaction(operation);
    return run();
  }

  private writeRecord(record: MarketRecord): void {
    const validated = MarketRecordSchema.parse(record);
    this.db
      .prepare(
        `UPDATE markets SET status = @status, updated_at = @updatedAt, approved_at = @approvedAt,
           discarded_at = @discardedAt, revision = @revision, market_json = @marketJson,
           issues_json = @issuesJson WHERE id = @id`,
      )
      .run({
        id: validated.id,
        status: validated.status,
        updatedAt: validated.updatedAt,
        approvedAt: validated.approvedAt,
        discardedAt: validated.discardedAt,
        revision: validated.revision,
        marketJson: JSON.stringify(validated.market),
        issuesJson: JSON.stringify(validated.semanticIssues),
      });
  }

  private toRecord(row: MarketRow): MarketRecord {
    let candidate: unknown;
    try {
      candidate = {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        approvedAt: row.approved_at,
        discardedAt: row.discarded_at,
        generationMode: row.generation_mode,
        generationProvider: row.generation_provider,
        sourceVerification: "syntactic-only",
        revision: row.revision,
        market: JSON.parse(row.market_json) as unknown,
        semanticIssues: JSON.parse(row.issues_json) as unknown,
      };
    } catch (error) {
      throw new MarketStoreError(`stored market ${row.id} contains invalid JSON`, { cause: error });
    }
    const parsed = MarketRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new MarketStoreError(`stored market ${row.id} failed record validation`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
