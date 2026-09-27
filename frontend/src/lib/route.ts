const LIVE = /^\/game\/([^/]+)\/live\/?$/;

export type AppRoute = { name: "start" } | { name: "dashboard" } | { name: "live"; gameId: string };

export function parseRoute(pathname: string): AppRoute {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return { name: "dashboard" };
  const match = LIVE.exec(pathname);
  if (!match) return { name: "start" };
  try {
    const encodedId = match[1];
    if (!encodedId) return { name: "start" };
    return { name: "live", gameId: decodeURIComponent(encodedId) };
  } catch {
    return { name: "start" };
  }
}

export function livePath(gameId: string): string {
  return `/game/${encodeURIComponent(gameId)}/live`;
}

export function dashboardPath(): string {
  return "/dashboard";
}
