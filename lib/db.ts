import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import type { DatabaseEnv } from "../types.ts";

const clients = new Map<string, Client>();

export function getDb(env: DatabaseEnv): Client {
  const url = env?.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("Missing TURSO_DATABASE_URL");
  }

  let client = clients.get(url);
  if (!client) {
    client = createClient({
      url,
      authToken: env.TURSO_AUTH_TOKEN,
      intMode: "number",
    });
    clients.set(url, client);
  }
  return client;
}

export function closeDb(env: DatabaseEnv): void {
  const url = env?.TURSO_DATABASE_URL;
  if (!url) return;
  const client = clients.get(url);
  if (!client) return;
  client.close();
  clients.delete(url);
}
