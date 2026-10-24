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

function waitForSyncChange(
  page: Page,
  entity: string,
  fields: Record<string, ExpectedSyncValue>,
  timeout = 10_000,
) {
  return page.waitForResponse(
    (response) => {
      if (
        new URL(response.url()).pathname !== "/api/sync" ||
        response.request().method() !== "POST"
      )
        return false;
      const body = response.request().postDataJSON() as {
        changes?: Array<{ entity?: string; fields?: Record<string, { v?: unknown }> }>;
      };
      return (
        body.changes?.some(
          (change) =>
            change.entity === entity &&
            Object.entries(fields).every(([field, value]) => {
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

test("applies configured defaults to new tasks in All", async ({ page }) => {
  await openApp(page);
  const projectName = newTitle("X");
  await page.getByRole("button", { name: "プロジェクトを作成", exact: true }).click();
  const projectForm = page.locator("form").filter({ has: page.getByLabel("プロジェクト名") });
  await projectForm.getByLabel("プロジェクト名").fill(projectName);
  const projectSync = waitForSyncChange(page, "project", { name: projectName });
  await projectForm.getByRole("button", { name: "プロジェクトを作成", exact: true }).click();
  const projectResponse = await projectSync;
  expect(projectResponse.ok()).toBe(true);
  const projectChange = (
    projectResponse.request().postDataJSON() as {
      changes: Array<{ entity: string; id: string; fields?: Record<string, { v?: unknown }> }>;
    }
  ).changes.find((change) => change.entity === "project" && change.fields?.name?.v === projectName);
  expect(projectChange).toBeTruthy();
  const projectId = projectChange!.id;

  await page.getByRole("button", { name: "設定", exact: true }).click();
  const prioritySync = waitForSyncChange(page, "settings", { default_priority: 3 });
  await page.getByLabel("既定の優先度").selectOption("3");
  expect((await prioritySync).ok()).toBe(true);
  const projectSettingSync = waitForSyncChange(page, "settings", {
    default_project_id: projectId,
  });
  await page.getByLabel("既定のプロジェクト").selectOption(projectId);
  expect((await projectSettingSync).ok()).toBe(true);

  await page.getByRole("button", { name: "すべて", exact: true }).click();
  const title = newTitle("e2e-defaults");
  await page.getByRole("textbox", { name: "タスク名", exact: true }).fill(title);
  const taskSync = waitForSyncResponse(page, {
    fields: { title, project_id: projectId, priority: 3 },
  });
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  await expect(taskRow(page, title)).toBeVisible();
  expect((await taskSync).ok()).toBe(true);
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

test("keeps an unsynced task through authentication failure and reload, then syncs it", async ({
  page,
  browser,
}) => {
  await openApp(page);
  const title = newTitle("e2e-reauth");
  await page.route("**/api/sync", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized" }),
    }),
  );
  await page.getByRole("textbox", { name: "タスク名", exact: true }).fill(title);
  const rejected = waitForSyncResponse(page, { fields: { title } });
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(taskRow(page, title)).toBeVisible();
  await expect(page.getByText("再ログインが必要です。", { exact: true }).first()).toBeVisible();

  const rejectedReload = waitForSyncResponse(page, { fields: { title } });
  await page.reload();
  expect((await rejectedReload).status()).toBe(401);
  await expect(taskRow(page, title)).toBeVisible();
  await page.unroute("**/api/sync");
  const recovered = waitForSyncResponse(page, { fields: { title } });
  await page.reload();
  expect((await recovered).ok()).toBe(true);
  await waitUntilSynced(page);

  const otherContext = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "block",
  });
  try {
    const otherPage = await otherContext.newPage();
    await openApp(otherPage);
    await expect(taskRow(otherPage, title)).toHaveCount(1);
  } finally {
    await otherContext.close();
  }
});

test("cancels permanent deletion, then confirms it and persists deletion after reload", async ({
  page,
}) => {
  await openApp(page);
  const title = newTitle("e2e-purge");
  const taskId = await addTask(page, title);
  const deleted = waitForSyncResponse(page, {
    id: taskId,
    fields: { deleted_at: (value) => typeof value === "string" },
  });
  await taskRow(page, title)
    .getByRole("button", { name: `「${title}」をゴミ箱へ移動` })
    .click();
  expect((await deleted).ok()).toBe(true);
  await page.getByRole("button", { name: /^ゴミ箱/ }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await row.getByRole("button", { name: "完全削除", exact: true }).click();
  await expect(row).toBeVisible();
  const retained = waitForPullResponse(page);
  await page.reload();
  expect((await retained).ok()).toBe(true);
  await waitUntilSynced(page);
  await page.getByRole("button", { name: /^ゴミ箱/ }).click();
  await expect(row).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const purged = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/trash/purge" &&
      response.request().postDataJSON().id === taskId,
  );
  await row.getByRole("button", { name: "完全削除", exact: true }).click();
  expect((await purged).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await waitUntilSynced(page);
  const reloaded = waitForPullResponse(page);
  await page.reload();
  expect((await reloaded).ok()).toBe(true);
  await waitUntilSynced(page);
  await expect(taskRow(page, title)).toHaveCount(0);
  await page.getByRole("button", { name: /^ゴミ箱/ }).click();
  await expect(row).toHaveCount(0);
});
