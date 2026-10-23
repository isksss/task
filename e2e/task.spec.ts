import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "すべて", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "タスク名", exact: true })).toBeVisible();
  await waitUntilSynced(page);
}

function taskRow(page: Page, title: string) {
  return page
    .getByRole("list", { name: "すべて", exact: true })
    .getByRole("listitem")
    .filter({ hasText: title });
}

type ExpectedSyncValue = string | number | boolean | null | ((value: unknown) => boolean);
type ExpectedTaskChange = { id?: string; fields: Record<string, ExpectedSyncValue> };

function waitForSyncResponse(page: Page, expected: ExpectedTaskChange, timeout = 10_000) {
  return page.waitForResponse(
    (response) => {
      if (
        new URL(response.url()).pathname !== "/api/sync" ||
        response.request().method() !== "POST"
      )
        return false;
      const body = response.request().postDataJSON() as {
        changes?: Array<{ entity?: string; id?: string; fields?: Record<string, { v?: unknown }> }>;
      };
      return (
        body.changes?.some(
          (change) =>
            change.entity === "task" &&
            (expected.id === undefined || change.id === expected.id) &&
            Object.entries(expected.fields).every(([field, value]) => {
              const actual = change.fields?.[field]?.v;
              return typeof value === "function" ? value(actual) : actual === value;
            }),
        ) ?? false
      );
    },
    { timeout },
  );
}

function waitForPullResponse(page: Page, timeout = 10_000) {
  return page.waitForResponse(
    (response) => {
      if (
        new URL(response.url()).pathname !== "/api/sync" ||
        response.request().method() !== "POST"
      )
        return false;
      const body = response.request().postDataJSON() as { changes?: unknown[] };
      return body.changes?.length === 0;
    },
    { timeout },
  );
}

async function waitUntilSynced(page: Page): Promise<void> {
  await expect(page.getByText("同期済み", { exact: true }).first()).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<string> {
  await page.getByRole("textbox", { name: "タスク名", exact: true }).fill(title);
  const syncResponse = waitForSyncResponse(page, { fields: { title } });
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  await expect(taskRow(page, title)).toBeVisible();
  const response = await syncResponse;
  expect(response.ok()).toBe(true);
  const body = response.request().postDataJSON() as {
    changes: Array<{ entity: string; id: string; fields?: Record<string, { v?: unknown }> }>;
  };
  const id = body.changes.find(
    (change) => change.entity === "task" && change.fields?.title?.v === title,
  )?.id;
  expect(id).toBeTruthy();
  return id!;
}

function newTitle(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

test("creates, completes, trashes, and restores a task", async ({ page }) => {
  await openApp(page);
  const title = newTitle("e2e-trash");
  const taskId = await addTask(page, title);

  await page.getByRole("checkbox", { name: "完了済みも表示" }).check();
  const completeSync = waitForSyncResponse(page, { id: taskId, fields: { done: true } });
  await taskRow(page, title)
    .getByRole("checkbox", { name: `完了にする：${title}` })
    .click();
  await expect(
    taskRow(page, title).getByRole("checkbox", { name: `未完了にする：${title}` }),
  ).toBeChecked();
  expect((await completeSync).ok()).toBe(true);

  const deleteSync = waitForSyncResponse(page, {
    id: taskId,
    fields: { deleted_at: (value) => typeof value === "string" },
  });
  await taskRow(page, title)
    .getByRole("button", { name: `「${title}」をゴミ箱へ移動` })
    .click();
  expect((await deleteSync).ok()).toBe(true);
  await page.getByRole("button", { name: /^ゴミ箱/ }).click();
  const trashedTask = page.getByRole("listitem").filter({ hasText: title });
  await expect(trashedTask).toBeVisible();
  const restoreSync = waitForSyncResponse(page, { id: taskId, fields: { deleted_at: null } });
  await trashedTask.getByRole("button", { name: "復元", exact: true }).click();
  expect((await restoreSync).ok()).toBe(true);

  await page.getByRole("button", { name: "すべて", exact: true }).click();
  await expect(taskRow(page, title)).toBeVisible();

  const reloadSync = waitForPullResponse(page);
  await page.reload();
  expect((await reloadSync).ok()).toBe(true);
  await waitUntilSynced(page);
  await page.getByRole("checkbox", { name: "完了済みも表示" }).check();
  await expect(taskRow(page, title)).toBeVisible();
});

test("syncs an offline edit to another browser context after reconnecting", async ({
  page,
  browser,
}) => {
  await openApp(page);
  const title = newTitle("e2e-offline");
  const updatedTitle = `${title}-online`;
  const taskId = await addTask(page, title);

  const otherContext = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "block",
  });
  try {
    const otherPage = await otherContext.newPage();
    await openApp(otherPage);
    await expect(taskRow(otherPage, title)).toBeVisible();

    await page.context().setOffline(true);
    await taskRow(page, title).getByRole("button", { name: "編集", exact: true }).click();
    const editor = page.getByRole("dialog");
    await editor.getByLabel("タスク名").first().fill(updatedTitle);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(taskRow(page, updatedTitle)).toBeVisible();
    await expect(page.getByText(/^オフライン/).first()).toBeVisible();

    await page.evaluate(() => {
      window.addEventListener(
        "online",
        () => {
          document.documentElement.dataset.onlineEventSeen = "true";
        },
        { once: true },
      );
    });
    const reconnectSync = waitForSyncResponse(
      page,
      { id: taskId, fields: { title: updatedTitle } },
      5_000,
    );
    await page.context().setOffline(false);
    await expect
      .poll(() => page.locator("html").getAttribute("data-online-event-seen"), { timeout: 5_000 })
      .toBe("true");
    expect((await reconnectSync).ok()).toBe(true);
    await expect(taskRow(page, updatedTitle)).toBeVisible();
    const otherSync = waitForPullResponse(otherPage);
    await otherPage.reload();
    expect((await otherSync).ok()).toBe(true);
    await expect(taskRow(otherPage, updatedTitle)).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test("keeps concurrent edits to different task fields", async ({ page, browser }) => {
  await openApp(page);
  const title = newTitle("e2e-concurrent");
  const updatedTitle = `${title}-renamed`;
  const note = `note-${randomUUID()}`;
  const taskId = await addTask(page, title);

  const otherContext = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "block",
  });
  try {
    const otherPage = await otherContext.newPage();
    await openApp(otherPage);
    await expect(taskRow(otherPage, title)).toBeVisible();

    await taskRow(page, title).getByRole("button", { name: "編集", exact: true }).click();
    await taskRow(otherPage, title).getByRole("button", { name: "編集", exact: true }).click();
    const editor = page.getByRole("dialog");
    const otherEditor = otherPage.getByRole("dialog");
    await editor.getByLabel("タスク名").first().fill(updatedTitle);
    await otherEditor.getByLabel("メモ").fill(note);

    const pageSync = waitForSyncResponse(page, { id: taskId, fields: { title: updatedTitle } });
    const otherPageSync = waitForSyncResponse(otherPage, { id: taskId, fields: { note } });
    await Promise.all([
      editor.getByRole("button", { name: "保存", exact: true }).click(),
      otherEditor.getByRole("button", { name: "保存", exact: true }).click(),
    ]);
    expect((await pageSync).ok()).toBe(true);
    expect((await otherPageSync).ok()).toBe(true);

    const reloadSync = waitForPullResponse(page);
    const otherReloadSync = waitForPullResponse(otherPage);
    await Promise.all([page.reload(), otherPage.reload()]);
    expect((await reloadSync).ok()).toBe(true);
    expect((await otherReloadSync).ok()).toBe(true);
    await Promise.all([waitUntilSynced(page), waitUntilSynced(otherPage)]);
    await expect(taskRow(page, updatedTitle)).toBeVisible();
    await taskRow(page, updatedTitle).getByRole("button", { name: "編集", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("メモ")).toHaveValue(note);
  } finally {
    await otherContext.close();
  }
});
