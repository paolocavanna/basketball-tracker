export function json(body, status = 200) {
  return Response.json(body, { status });
}

export function error(status, message) {
  return json({ error: message }, status);
}

export async function readJson(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "Expected a JSON body" };
  }
  if (text.trim() === "") return { error: "Expected a JSON body" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "Expected a JSON body" };
  }
}

export function serverError(err) {
  console.error(err);
  return error(500, "Internal server error");
}

export async function handle(fn) {
  try {
    return await fn();
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message.includes("CHECK constraint")) {
      return error(400, "Event violates the statistics rules");
    }
    if (message.includes("FOREIGN KEY")) {
      return error(404, "Related record not found");
    }
    return serverError(err);
  }
}
