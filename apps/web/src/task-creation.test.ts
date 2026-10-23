import { describe, expect, it } from "vitest";
import { resolveTaskCreationDefaults, type TaskCreationView } from "./task-creation";

const activeProject = { id: "active", deleted_at: null };
const deletedProject = { id: "deleted", deleted_at: "2026-01-01T00:00:00.000Z" };

const views: [TaskCreationView, string | null][] = [
  ["all", "active"],
  ["inbox", null],
  ["today", "active"],
  ["overdue", "active"],
  ["calendar", "active"],
  [{ tagId: "tag" }, "active"],
  [{ projectId: "selected" }, "selected"],
];

describe("new task defaults", () => {
  it.each(views)("uses the right project in %s", (view, expectedProjectId) => {
    expect(
      resolveTaskCreationDefaults(view, "selected", "active", [activeProject, deletedProject], 3),
    ).toEqual({ projectId: expectedProjectId, priority: 3 });
  });

  it("uses the inbox when the saved default project is deleted or missing", () => {
    for (const defaultProjectId of ["deleted", "missing"]) {
      expect(
        resolveTaskCreationDefaults(
          "all",
          null,
          defaultProjectId,
          [activeProject, deletedProject],
          2,
        ),
      ).toEqual({ projectId: null, priority: 2 });
    }
  });
});
