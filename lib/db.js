import { createClient } from "@libsql/client";

const clients = new Map();

export function getDb(env) {
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

export function closeDb(env) {
  const url = env?.TURSO_DATABASE_URL;
  const client = url ? clients.get(url) : undefined;
  if (!client) return;
  client.close();
  clients.delete(url);
}
