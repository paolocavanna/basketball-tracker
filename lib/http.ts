export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

export type JsonReadResult = { value: unknown } | { error: string };

export async function readJson(request: Request): Promise<JsonReadResult> {
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "Expected a JSON body" };
  }
  if (text.trim() === "") return { error: "Expected a JSON body" };
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return { error: "Expected a JSON body" };
  }
}

export function serverError(err: unknown): Response {
  console.error(err);
  return error(500, "Internal server error");
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("CHECK constraint")) {
      return error(400, "Event violates the statistics rules");
    }
    if (message.includes("FOREIGN KEY")) {
      return error(404, "Related record not found");
    }
    return serverError(err);
  }
}
