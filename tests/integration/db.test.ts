import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { MarketStore, MarketStoreError } from "../../src/lib/db";
import { FIXED_NOW, validMarketFields } from "../helpers/fixtures";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "htm-db-"));
  tempDirs.push(dir);
  return join(dir, "markets.db");
}

function createParams() {
  return {
    id: crypto.randomUUID(),
    market: { ...validMarketFields(), outcome: "resolvable" as const, status: "draft" as const },
    issues: [],
    generationMode: "heuristic" as const,
    generationProvider: "test",
    now: FIXED_NOW,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MarketStore persistence and trust boundaries", () => {
  test("round-trips a record through SQLite with validation on both sides", () => {
    const store = new MarketStore(":memory:");
    const params = createParams();
    const created = store.create(params);
    const loaded = store.get(created.id);
    expect(loaded).toEqual(created);
    store.close();
  });

  test("persists across store instances on the same file", () => {
    const path = tempDbPath();
    const first = new MarketStore(path);
    const created = first.create(createParams());
    first.close();

    const second = new MarketStore(path);
    expect(second.get(created.id)?.id).toBe(created.id);
    second.close();
  });

  test("forces created records to draft even if the caller supplies another status", () => {
    const store = new MarketStore(":memory:");
    const params = createParams();
    const created = store.create({
      ...params,
      market: { ...params.market, status: "approved" },
    });
    expect(created.status).toBe("draft");
    expect(created.market.status).toBe("draft");
    store.close();
  });

  test("corrupted rows are rejected at read time instead of being trusted", () => {
    const path = tempDbPath();
    const store = new MarketStore(path);
    const created = store.create(createParams());
    store.close();

    const raw = new Database(path);
    raw.prepare("UPDATE markets SET market_json = ? WHERE id = ?").run("{not valid json", created.id);
    raw.close();

    const reopened = new MarketStore(path);
    let error: unknown;
    try {
      reopened.get(created.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MarketStoreError);
    reopened.close();
  });

  test("updateStatus keeps market.status mirrored and timestamps the transition", () => {
    const store = new MarketStore(":memory:");
    const created = store.create(createParams());
    const approved = store.updateStatus(created.id, "approved", FIXED_NOW);
    expect(approved.status).toBe("approved");
    expect(approved.market.status).toBe("approved");
    expect(approved.approvedAt).toBe(FIXED_NOW.toISOString());

    const discarded = store.updateStatus(created.id, "discarded", FIXED_NOW);
    expect(discarded.discardedAt).toBe(FIXED_NOW.toISOString());
    store.close();
  });

  test("list clamps limits and orders by creation time", () => {
    const store = new MarketStore(":memory:");
    const ids = [
      store.create({ ...createParams(), now: new Date("2026-01-01T00:00:00.000Z") }).id,
      store.create({ ...createParams(), now: new Date("2026-02-01T00:00:00.000Z") }).id,
      store.create({ ...createParams(), now: new Date("2026-03-01T00:00:00.000Z") }).id,
    ];
    expect(store.list().map((record) => record.id)).toEqual([...ids].reverse());
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(0)).toHaveLength(1);
    store.close();
  });

  test("create rejects a record that cannot satisfy the record schema", () => {
    const store = new MarketStore(":memory:");
    expect(() =>
      store.create({
        ...createParams(),
        id: "not-a-uuid",
      }),
    ).toThrow();
    store.close();
  });
});
