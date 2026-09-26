const LIVE = /^\/game\/([^/]+)\/live\/?$/;

export function parseRoute(pathname) {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return { name: "dashboard" };
  const match = LIVE.exec(pathname);
  if (!match) return { name: "start" };
  try {
    return { name: "live", gameId: decodeURIComponent(match[1]) };
  } catch {
    return { name: "start" };
  }
}

export function livePath(gameId) {
  return `/game/${encodeURIComponent(gameId)}/live`;
}

export function dashboardPath() {
  return "/dashboard";
}
