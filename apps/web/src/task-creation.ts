import type { Priority, Project } from "@task/shared";

export type TaskCreationView =
  | "all"
  | "inbox"
  | "today"
  | "overdue"
  | "trash"
  | "calendar"
  | "settings"
  | { projectId: string }
  | { tagId: string };

export function resolveTaskCreationDefaults(
  view: TaskCreationView,
  selectedProjectId: string | null,
  defaultProjectId: string | null,
  projects: Pick<Project, "id" | "deleted_at">[],
  defaultPriority: Priority,
): { projectId: string | null; priority: Priority } {
  const projectId =
    typeof view !== "string" && "projectId" in view
      ? selectedProjectId
      : view === "inbox"
        ? null
        : projects.some(({ id, deleted_at }) => id === defaultProjectId && deleted_at === null)
          ? defaultProjectId
          : null;
  return { projectId, priority: defaultPriority };
}
