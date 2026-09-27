const LIVE = /^\/game\/([^/]+)\/live\/?$/;
const SUMMARY = /^\/game\/([^/]+)\/summary\/?$/;

export type AppRoute =
  | { name: "start" }
  | { name: "dashboard" }
  | { name: "live"; gameId: string }
  | { name: "summary"; gameId: string };

function gameRoute(pattern: RegExp, pathname: string, name: "live" | "summary"): AppRoute | null {
  const match = pattern.exec(pathname);
  if (!match) return null;
  try {
    const encodedId = match[1];
    if (!encodedId) return { name: "start" };
    return { name, gameId: decodeURIComponent(encodedId) };
  } catch {
    return { name: "start" };
  }
}

export function parseRoute(pathname: string): AppRoute {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return { name: "dashboard" };
  return (
    gameRoute(LIVE, pathname, "live") ??
    gameRoute(SUMMARY, pathname, "summary") ?? { name: "start" }
  );
}

export function livePath(gameId: string): string {
  return `/game/${encodeURIComponent(gameId)}/live`;
}

export function summaryPath(gameId: string): string {
  return `/game/${encodeURIComponent(gameId)}/summary`;
}

export function dashboardPath(): string {
  return "/dashboard";
}
