import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadExport, requestExportAfterSync } from "./export";
import { fetchApiResponse, ReauthenticationRequired } from "./sync";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("export download", () => {
  it("saves the response using its safe attachment filename and releases the object URL", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const link = {
      click,
      remove,
      href: "",
      download: "",
      hidden: false,
    } as unknown as HTMLAnchorElement;
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { append } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-export");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const response = new Response('{"format":"task-export","version":1}', {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="task-export-2026-01-02.json"',
      },
    });

    await downloadExport(response);

    expect(link.download).toBe("task-export-2026-01-02.json");
    expect(link.href).toBe("blob:task-export");
    expect(link.hidden).toBe(true);
    expect(append).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(revoke).toHaveBeenCalledWith("blob:task-export");
  });
});

describe("export request", () => {
  it("waits for synchronization before fetching the export", async () => {
    const calls: string[] = [];
    const sync = vi.fn(async () => {
      calls.push("sync");
    });
    const response = new Response("{}", { headers: { "Content-Type": "application/json" } });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("export");
      return response;
    });

    await expect(requestExportAfterSync(sync, fetcher)).resolves.toBe(response);
    expect(calls).toEqual(["sync", "export"]);
  });

  it("does not fetch or export when synchronization fails", async () => {
    const sync = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("sync failed"));
    const fetcher = vi.fn<typeof fetch>();

    await expect(requestExportAfterSync(sync, fetcher)).rejects.toThrow("sync failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("authenticated API response", () => {
  it("uses manual redirects and marks an Access response as reauthentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await fetchApiResponse(fetcher, "/api/export", { method: "GET" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/export",
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "manual",
      }),
    );

    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(fetchApiResponse(unauthorized, "/api/export")).rejects.toBeInstanceOf(
      ReauthenticationRequired,
    );
  });
});
