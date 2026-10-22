import { describe, expect, it } from "vitest";
import { getPrecacheUrls, isNetworkOnlyPath, shouldUseAppShellFallback } from "./sw-routing";

describe("service worker routing", () => {
  it("bypasses API and Cloudflare Access paths, but not similarly named paths", () => {
    expect(isNetworkOnlyPath("/api")).toBe(true);
    expect(isNetworkOnlyPath("/api/sync")).toBe(true);
    expect(isNetworkOnlyPath("/cdn-cgi/access/login")).toBe(true);
    expect(isNetworkOnlyPath("/apiary")).toBe(false);
    expect(isNetworkOnlyPath("/cdn-cgi-extra")).toBe(false);
  });

  it("precaches unique same-origin resources but excludes API and Access paths", () => {
    expect(getPrecacheUrls([
      { url: "index.html" },
      { url: "assets/app.js" },
      { url: "assets/app.js" },
      { url: "api/sync" },
      { url: "cdn-cgi/access/login" },
      { url: "https://cdn.example/app.js" },
    ], "https://task.example/"))
      .toEqual(["https://task.example/index.html", "https://task.example/assets/app.js"]);
  });

  it("uses the app shell only when an app navigation has no network response", () => {
    const navigation = { mode: "navigate", url: "https://task.example/projects" } as Request;
    expect(shouldUseAppShellFallback(navigation, undefined)).toBe(true);
    expect(shouldUseAppShellFallback(navigation, Response.redirect("https://login.example"))).toBe(false);
    expect(shouldUseAppShellFallback(navigation, new Response(null, { status: 401 }))).toBe(false);
    expect(shouldUseAppShellFallback({ ...navigation, mode: "cors" } as Request, undefined)).toBe(false);
    expect(shouldUseAppShellFallback({ ...navigation, url: "https://task.example/api/sync" }, undefined)).toBe(false);
  });
});
