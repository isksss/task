export function isNetworkOnlyPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/cdn-cgi" || pathname.startsWith("/cdn-cgi/");
}

export function shouldUseAppShellFallback(
  request: Pick<Request, "mode" | "url">,
  response: Response | undefined,
): boolean {
  return request.mode === "navigate" && response === undefined && !isNetworkOnlyPath(new URL(request.url).pathname);
}

export function getPrecacheUrls(entries: readonly { url: string }[], scope: string): string[] {
  const origin = new URL(scope).origin;
  return [...new Set(
    entries
      .map(({ url }) => new URL(url, scope))
      .filter((url) => url.origin === origin && !isNetworkOnlyPath(url.pathname))
      .map((url) => url.href),
  )];
}
