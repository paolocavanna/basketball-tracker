import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadDotEnv() {
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

function redact(message) {
  let text = String(message);
  for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function splitSql(script) {
  const statements = [];
  let current = "";
  for (const line of script.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    current += `${line}\n`;
    if (line.trim().endsWith(";")) {
      const statement = current.trim().replace(/;$/, "").trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }
  const tail = current.trim().replace(/;$/, "").trim();
  if (tail) statements.push(tail);
  return statements;
}

function alreadyApplied(err) {
  const message = String(err?.message ?? err);
  return (
    message.includes("already exists") || message.includes("UNIQUE constraint failed: teams.slug")
  );
}

async function main() {
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
    const sql = readFileSync(join(root, "db", "schema.sql"), "utf8");
    for (const statement of splitSql(sql)) {
      try {
        await client.execute(statement);
      } catch (err) {
        if (!alreadyApplied(err)) throw err;
      }
    }
    console.log("Schema applied");
  } catch (err) {
    console.error(redact(err?.message ?? err));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

await main();
