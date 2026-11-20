import type Database from "better-sqlite3";
import type { ExecutorApp } from "../../contract.js";

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
  `
  ALTER TABLE connection ADD COLUMN cf_client_id TEXT;
  ALTER TABLE connection ADD COLUMN cf_client_secret TEXT;
  `,
  `
  ALTER TABLE connection ADD COLUMN apps TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE connection ADD COLUMN organization TEXT;
  `,
  `
  ALTER TABLE connection ADD COLUMN mode TEXT;
  `,
];

/** A tool as Executor lists it, cached so the load path never waits on the server. */
export interface ExecutorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What the plugin sends on every request: an Executor API key and a Cloudflare Access service token. */
export interface Credentials {
  token: string | null;
  cfClientId: string | null;
  cfClientSecret: string | null;
}

export interface Connection extends Credentials {
  url: string | null;
  error: string | null;
  tools: ExecutorTool[];
  apps: ExecutorApp[];
  /** Organization slug, for dashboard links. */
  organization: string | null;
  /** The approval mode Executor applies to this connection. */
  mode: string | null;
  syncedAt: number | null;
  approveAll: boolean;
}

export interface Store {
  get(): Connection;
  setTarget(url: string | null, credentials: Credentials): void;
  /** A different server's catalog says nothing about the new one. */
  clearCatalog(): void;
  setCatalog(tools: ExecutorTool[], apps: ExecutorApp[], organization: string | null, mode: string | null): void;
  setError(error: string | null): void;
  setApproveAll(enabled: boolean): void;
  rules(): string[];
  addRule(pattern: string): void;
  deleteRule(pattern: string): void;
}

interface Row {
  url: string | null;
  token: string | null;
  cf_client_id: string | null;
  cf_client_secret: string | null;
  error: string | null;
  tools: string;
  apps: string;
  organization: string | null;
  mode: string | null;
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
        cfClientId: row.cf_client_id,
        cfClientSecret: row.cf_client_secret,
        error: row.error,
        tools: JSON.parse(row.tools) as ExecutorTool[],
        apps: JSON.parse(row.apps) as ExecutorApp[],
        organization: row.organization,
        mode: row.mode,
        syncedAt: row.synced_at,
        approveAll: row.approve_all === 1,
      };
    },
    setTarget(url, { token, cfClientId, cfClientSecret }) {
      db.prepare(
        "UPDATE connection SET url = ?, token = ?, cf_client_id = ?, cf_client_secret = ?, error = NULL WHERE id = 1",
      ).run(url, token, cfClientId, cfClientSecret);
    },
    clearCatalog() {
      db.prepare(
        "UPDATE connection SET tools = '[]', apps = '[]', organization = NULL, mode = NULL, synced_at = NULL WHERE id = 1",
      ).run();
    },
    setCatalog(tools, apps, organization, mode) {
      db.prepare(
        "UPDATE connection SET tools = ?, apps = ?, organization = ?, mode = ?, synced_at = ?, error = NULL WHERE id = 1",
      ).run(JSON.stringify(tools), JSON.stringify(apps), organization, mode, Date.now());
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
