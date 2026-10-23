export type PushAvailability = "available" | "unsupported" | "install-on-ios";

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function pushAvailability(): PushAvailability {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    return "unsupported";
  const nav = navigator as Navigator & { standalone?: boolean };
  const isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (
    isIOS &&
    nav.standalone !== true &&
    !window.matchMedia("(display-mode: standalone)").matches
  ) {
    return "install-on-ios";
  }
  return "available";
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (
    response.type === "opaqueredirect" ||
    response.status === 0 ||
    response.status === 401 ||
    response.status === 403
  ) {
    throw new Error("reauthentication_required");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("reauthentication_required");
  }
  if (!response.ok) throw new Error(`push_api_failed_${response.status}`);
  return response.json();
}

export async function readPushSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function registerPushSubscription(subscription: PushSubscription): Promise<void> {
  await apiRequest("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
}

export async function registerExistingPushSubscription(): Promise<boolean> {
  const subscription = await readPushSubscription();
  if (!subscription) return false;
  await registerPushSubscription(subscription);
  return true;
}

export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification_permission_denied");
  const result = await apiRequest("/api/push/vapid-public-key");
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as { publicKey?: unknown }).publicKey !== "string"
  ) {
    throw new Error("invalid_vapid_public_key");
  }
  const key = decodeBase64Url((result as { publicKey: string }).publicKey);
  if (!key || key.byteLength !== 65 || key[0] !== 4) throw new Error("invalid_vapid_public_key");
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bufferOf(key),
    }));
  await registerPushSubscription(subscription);
}

export async function disablePush(): Promise<void> {
  const subscription = await readPushSubscription();
  if (!subscription) return;
  await apiRequest("/api/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  if (!(await subscription.unsubscribe())) throw new Error("push_unsubscribe_failed");
}
