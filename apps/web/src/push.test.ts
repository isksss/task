import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExistingPushSubscription } from "./push";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push subscription restoration", () => {
  it("registers an existing browser subscription with the server", async () => {
    const json = { endpoint: "https://push.example/endpoint", keys: { p256dh: "public", auth: "secret" } };
    const subscription = { toJSON: () => json } as unknown as PushSubscription;
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) } });
    const fetcher = vi.fn(async () => new Response("{}", {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(registerExistingPushSubscription()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/push/subscriptions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(json),
      credentials: "same-origin",
      redirect: "manual",
    }));
  });

  it("propagates registration failures so the UI cannot report notifications as enabled", async () => {
    const subscription = { toJSON: () => ({ endpoint: "https://push.example/endpoint", keys: {} }) } as unknown as PushSubscription;
    vi.stubGlobal("navigator", {
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }) },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(registerExistingPushSubscription()).rejects.toThrow("push_api_failed_503");
  });
});
