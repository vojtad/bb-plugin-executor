import type Database from "better-sqlite3";

/** Appended, never edited: the array index is the migration id. */
export const MIGRATIONS = [
  `
  CREATE TABLE connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    url TEXT,
    token TEXT,
    error TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    synced_at INTEGER,
    approve_all INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO connection (id) VALUES (1);
  CREATE TABLE rules (pattern TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  CREATE TABLE oauth_tokens (
    server_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    obtained_at INTEGER NOT NULL DEFAULT 0,
    expires_in INTEGER
  );
  CREATE TABLE oauth_pending (
    server_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_clients (
    server_id TEXT PRIMARY KEY,
    resource_url TEXT NOT NULL,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    registration_endpoint TEXT,
    client_id TEXT NOT NULL,
    client_secret TEXT,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

/** A tool as Executor lists it, cached so the load path never waits on the server. */
export interface ExecutorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Connection {
  url: string | null;
  token: string | null;
  error: string | null;
  tools: ExecutorTool[];
  syncedAt: number | null;
  approveAll: boolean;
}

export interface Store {
  get(): Connection;
  setTarget(url: string | null, token: string | null): void;
  setTools(tools: ExecutorTool[]): void;
  setError(error: string | null): void;
  setApproveAll(enabled: boolean): void;
  rules(): string[];
  addRule(pattern: string): void;
  deleteRule(pattern: string): void;
}

interface Row {
  url: string | null;
  token: string | null;
  error: string | null;
  tools: string;
  synced_at: number | null;
  approve_all: number;
}

export function createStore(db: Database.Database): Store {
  return {
    get() {
      const row = db.prepare("SELECT * FROM connection WHERE id = 1").get() as Row;
      return {
        url: row.url,
        token: row.token,
        error: row.error,
        tools: JSON.parse(row.tools) as ExecutorTool[],
        syncedAt: row.synced_at,
        approveAll: row.approve_all === 1,
      };
    },
    setTarget(url, token) {
      // A different server's catalog says nothing about the new one.
      db.prepare(
        "UPDATE connection SET url = ?, token = ?, error = NULL, tools = '[]', synced_at = NULL WHERE id = 1",
      ).run(url, token);
    },
    setTools(tools) {
      db.prepare("UPDATE connection SET tools = ?, synced_at = ?, error = NULL WHERE id = 1")
        .run(JSON.stringify(tools), Date.now());
    },
    setError(error) {
      db.prepare("UPDATE connection SET error = ? WHERE id = 1").run(error);
    },
    setApproveAll(enabled) {
      db.prepare("UPDATE connection SET approve_all = ? WHERE id = 1").run(enabled ? 1 : 0);
    },
    rules() {
      return (db.prepare("SELECT pattern FROM rules ORDER BY pattern").all() as { pattern: string }[])
        .map((row) => row.pattern);
    },
    addRule(pattern) {
      db.prepare("INSERT OR IGNORE INTO rules (pattern, created_at) VALUES (?, ?)")
        .run(pattern, Date.now());
    },
    deleteRule(pattern) {
      db.prepare("DELETE FROM rules WHERE pattern = ?").run(pattern);
    },
  };
}
