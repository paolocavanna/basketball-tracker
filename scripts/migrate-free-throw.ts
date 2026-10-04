import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateFreeThrowEvents } from "../lib/migrateFreeThrow.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadDotEnv(): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function redact(message: string): string {
  let text = String(message);
  for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

async function main(): Promise<void> {
  loadDotEnv();
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    console.error("TURSO_DATABASE_URL is not set");
    process.exit(1);
  }

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });

  try {
    const result = await migrateFreeThrowEvents(client);
    console.log(
      result === "already" ? "Free throws already allowed" : "Free throw migration applied",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(redact(message));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

await main();
