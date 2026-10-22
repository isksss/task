import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  compareTasks,
  isTaskDueToday,
  isTaskOverdue,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  todayInTimeZone,
  type Locale,
  type Project,
  type Task,
  type TaskSort,
} from "@task/shared";
import {
  createProject,
  createTask,
  clearLocalData,
  db,
  deleteProject,
  deleteTask,
  getSettings,
  initializeDatabase,
  purgeTrash,
  restoreProject,
  restoreTask,
  updateProject,
  updateSettings,
  updateTask,
} from "./db";
import { clearDeviceDataConfirmation, dictionaries, getDefaultLocale, type Translation } from "./i18n";
import { firstDayOfWeek, getMonthGridDates, getWeekDates, shiftCalendarDate, shiftCalendarMonth } from "./calendar";
import { startSyncLoop, syncNow, syncSoon, waitForSync, type SyncStatus } from "./sync";
import styles from "./App.module.css";

type View = "all" | "inbox" | "today" | "overdue" | "trash" | "calendar" | "settings" | { projectId: string };
type CalendarMode = "month" | "week";

const SORT_KEY = "task.sort-by-view.v1";

function viewKey(view: View): string {
  return typeof view === "string" ? view : `project:${view.projectId}`;
}

function loadSorts(): Record<string, TaskSort> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SORT_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, TaskSort] =>
          ["due", "priority", "created"].includes(String(entry[1])),
        ),
      );
    }
  } catch {
    // localStorage can be unavailable in private browsing; sorting still works for this session.
  }
  return {};
}

function saveSorts(sorts: Record<string, TaskSort>): void {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sorts));
  } catch {
    // Keep the in-memory preference when persistent storage is unavailable.
  }
}

function trapDialogFocus(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const first = focusable.item(0);
  const last = focusable.item(focusable.length - 1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function taskHeading(view: View, projects: Project[], t: Translation): string {
  if (typeof view !== "string") return projects.find(({ id }) => id === view.projectId)?.name ?? t.projects;
  return ({ all: t.all, inbox: t.inbox, today: t.today, overdue: t.overdue, trash: t.trash, calendar: t.calendar, settings: t.settings })[view];
}

function formatTaskDue(task: Task, locale: Locale): string {
  if (!task.due_date) return "";
  const date = new Date(`${task.due_date}T12:00:00Z`);
  const formattedDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  if (!task.due_time) return formattedDate;
  const time = new Date(`${task.due_date}T${task.due_time}:00Z`);
  const formattedTime = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(time);
  return `${formattedDate} · ${formattedTime}`;
}

function descendants(projectId: string, projects: Project[]): Set<string> {
  const ids = new Set([projectId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (project.parent_id !== null && ids.has(project.parent_id) && !ids.has(project.id)) {
        ids.add(project.id);
        changed = true;
      }
    }
  }
  return ids;
}

function renderProjectTree(
  parentId: string | null,
  projects: Project[],
  activeId: string | null,
  onSelect: (project: Project) => void,
  t: Translation,
): ReactNode {
  const children = projects.filter((project) => project.parent_id === parentId && project.deleted_at === null);
  if (children.length === 0) return null;
  return (
    <ul className={styles.projectTree}>
      {children.map((project) => (
        <li key={project.id}>
          <button
            type="button"
            className={`${styles.projectLink} ${activeId === project.id ? styles.active : ""}`}
            aria-current={activeId === project.id ? "page" : undefined}
            onClick={() => onSelect(project)}
          >
            <span className={styles.projectDot} aria-hidden="true" />
            <span className={styles.projectLinkName}>{project.name || t.projects}</span>
          </button>
          {renderProjectTree(project.id, projects, activeId, onSelect, t)}
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [timezone, setTimezone] = useState("Asia/Tokyo");
  const [locale, setLocale] = useState<Locale>(getDefaultLocale());
  const [digestTime, setDigestTime] = useState("08:00");
  const [calendarDate, setCalendarDate] = useState<string | null>(null);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("month");
  const [view, setView] = useState<View>("all");
  const [sorts, setSorts] = useState<Record<string, TaskSort>>(loadSorts);
  const [showCompleted, setShowCompleted] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstNavigationItemRef = useRef<HTMLButtonElement>(null);
  const previousSidebarOpen = useRef(false);
  const stopSyncRef = useRef<(() => void) | undefined>(undefined);
  const clearingDeviceDataRef = useRef(false);
  const [status, setStatus] = useState<SyncStatus>("syncing");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const t = dictionaries[locale];
  const sortOptions: { value: TaskSort; label: string }[] = [
    { value: "due", label: t.due },
    { value: "priority", label: t.priority },
    { value: "created", label: t.created },
  ];
  const priorityLabels = [t.noPriority, t.low, t.medium, t.high];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (previousSidebarOpen.current === sidebarOpen) return;
    previousSidebarOpen.current = sidebarOpen;
    if (!isMobile) return;
    if (sidebarOpen) firstNavigationItemRef.current?.focus();
    else menuButtonRef.current?.focus();
  }, [isMobile, sidebarOpen]);

  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isMobile, sidebarOpen]);

  const refresh = useCallback(async () => {
    const [nextTasks, nextProjects, settings] = await Promise.all([
      db.tasks.toArray(),
      db.projects.toArray(),
      getSettings(),
    ]);
    setTasks(nextTasks);
    setProjects(nextProjects);
    setTimezone(settings.timezone);
    setLocale(settings.locale);
    setDigestTime(settings.digest_time);
  }, []);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void initializeDatabase().then(refresh).then(() => {
      if (!active) return;
      setReady(true);
      stop = startSyncLoop(setStatus, () => { void refresh(); });
      stopSyncRef.current = stop;
    }).catch(() => {
      setError(dictionaries[getDefaultLocale()].operationFailed);
    });
    return () => {
      active = false;
      stop?.();
      if (stopSyncRef.current === stop) stopSyncRef.current = undefined;
    };
  }, [refresh]);

  const act = useCallback(async (operation: () => Promise<unknown>) => {
    setError("");
    try {
      await operation();
      await refresh();
      syncSoon(db, setStatus);
    } catch (cause) {
      setError(cause instanceof RangeError ? t.invalidData : t.operationFailed);
    }
  }, [refresh, t]);

  const selectedProjectId = typeof view === "string" ? null : view.projectId;
  const selectedProject = selectedProjectId === null ? null : projects.find(({ id }) => id === selectedProjectId) ?? null;
  const activeProjects = useMemo(() => projects.filter(({ deleted_at }) => deleted_at === null), [projects]);
  const currentSort = sorts[viewKey(view)] ?? "due";
  const today = new Date();
  const regularTasks = tasks.filter((task) => {
    if (task.deleted_at !== null) return false;
    if (!showCompleted && task.done) return false;
    if (view === "inbox") return task.project_id === null;
    if (view === "today") return isTaskDueToday(task, today, timezone);
    if (view === "overdue") return isTaskOverdue(task, today, timezone);
    if (typeof view !== "string") return task.project_id !== null && descendants(view.projectId, activeProjects).has(task.project_id);
    return view === "all";
  }).sort((a, b) => compareTasks(a, b, currentSort));
  const activeCalendarTasks = tasks.filter((task) =>
    task.deleted_at === null && task.due_date !== null && (showCompleted || !task.done),
  );
  const focusedCalendarDate = calendarDate ?? todayInTimeZone(new Date(), timezone);
  const monthDays = focusedCalendarDate.slice(0, 7);
  const weekStart = firstDayOfWeek(locale);
  const calendarDates = calendarMode === "month"
    ? getMonthGridDates(monthDays, weekStart)
    : getWeekDates(focusedCalendarDate, weekStart);
  const calendarCounts = new Map<string, number>();
  for (const task of activeCalendarTasks) {
    const date = task.due_date!;
    calendarCounts.set(date, (calendarCounts.get(date) ?? 0) + 1);
  }
  const selectedDayTasks = activeCalendarTasks
    .filter((task) => task.due_date === focusedCalendarDate)
    .sort((a, b) => compareTasks(a, b, currentSort));
  const trashedTasks = tasks.filter(({ deleted_at }) => deleted_at !== null);
  const trashedProjects = projects.filter((project) => {
    if (project.deleted_at === null) return false;
    const parent = project.parent_id === null ? null : projects.find(({ id }) => id === project.parent_id);
    return !parent || parent.deleted_batch_id !== project.deleted_batch_id;
  });
  const editingTask = tasks.find(({ id, deleted_at }) => id === editingTaskId && deleted_at === null) ?? null;
  const editingProject = projects.find(({ id }) => id === editingProjectId) ?? null;

  const setCurrentSort = (value: TaskSort) => {
    const next = { ...sorts, [viewKey(view)]: value };
    setSorts(next);
    saveSorts(next);
  };

  const submitQuickTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = quickTitle;
    if (!title.trim()) return;
    const projectId = selectedProject?.deleted_at === null ? selectedProject.id : null;
    void act(async () => {
      await createTask(title, projectId);
      setQuickTitle("");
    });
  };

  const submitTaskEdit = (event: FormEvent<HTMLFormElement>, task: Task) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dueDate = String(form.get("due_date") ?? "");
    const dueTime = String(form.get("due_time") ?? "");
    const projectId = String(form.get("project_id") ?? "");
    void act(async () => {
      await updateTask(task.id, {
        title: String(form.get("title") ?? ""),
        done: form.get("done") === "on",
        due_date: dueDate || null,
        due_time: dueTime || null,
        note: String(form.get("note") ?? ""),
        priority: Number(form.get("priority")) as Task["priority"],
        project_id: projectId || null,
      });
      setEditingTaskId(null);
    });
  };

  const submitProjectEdit = (event: FormEvent<HTMLFormElement>, project: Project) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const parent = String(form.get("parent_id") ?? "");
    void act(async () => {
      await updateProject(project.id, { name, parent_id: parent || null });
      setEditingProjectId(null);
    });
  };

  const selectView = (next: View) => {
    setView(next);
    setSidebarOpen(false);
    setEditingTaskId(null);
    setEditingProjectId(null);
  };

  const renderRegularTask = (task: Task) => (
    <li key={task.id} className={styles.taskRow}>
      <label className={styles.taskMain}>
        <input
          type="checkbox"
          checked={task.done}
          aria-label={`${task.done ? t.reopenTask : t.completeTask}${t.labelSeparator}${task.title}`}
          onChange={(event) => { void act(() => updateTask(task.id, { done: event.target.checked })); }}
        />
        <span className={`${styles.taskTitle} ${task.done ? styles.done : ""}`}>{task.title}</span>
      </label>
      <div className={styles.taskMeta}>
        {task.due_date && <span className={styles.due}>{formatTaskDue(task, locale)}</span>}
        {task.priority > 0 && <span className={`${styles.priority} ${styles[`priority${task.priority}`]}`}>{priorityLabels[task.priority]}</span>}
        <button type="button" className={styles.textButton} onClick={() => setEditingTaskId(task.id)}>{t.edit}</button>
        <button type="button" className={styles.iconButton} aria-label={t.moveTaskToTrash.replace("{title}", task.title)} onClick={() => { void act(() => deleteTask(task.id)); }}>×</button>
      </div>
    </li>
  );

  const statusText = ({
    idle: t.synced,
    syncing: t.sync,
    offline: t.offline,
    reauth: t.reauth,
    error: t.syncError,
  })[status];
  const fullDateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const dayFormatter = new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: "UTC" });
  const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    weekdayFormatter.format(new Date(Date.UTC(2024, 0, 7 + ((weekStart + index) % 7)))),
  );
  const calendarTitle = calendarMode === "month"
    ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${monthDays}-01T12:00:00Z`))
    : `${fullDateFormatter.format(new Date(`${calendarDates[0]}T12:00:00Z`))} – ${fullDateFormatter.format(new Date(`${calendarDates[6]}T12:00:00Z`))}`;
  const taskCountText = (count: number) =>
    (locale === "en" && count === 1 ? t.taskCountOne : t.taskCount).replace("{count}", String(count));
  const calendarDayLabel = (date: string, count: number) =>
    (locale === "en" && count === 1 ? t.calendarDayLabelOne : t.calendarDayLabel)
      .replace("{date}", fullDateFormatter.format(new Date(`${date}T12:00:00Z`)))
      .replace("{count}", String(count));
  const timezoneValues = useMemo(() => {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
    try {
      return [...new Set(["Asia/Tokyo", timezone, ...(intl.supportedValuesOf?.("timeZone") ?? ["UTC"])])].sort();
    } catch {
      return [...new Set(["Asia/Tokyo", timezone, "UTC"])].sort();
    }
  }, [timezone]);
  const moveCalendar = (direction: -1 | 1) => setCalendarDate(
    calendarMode === "month"
      ? shiftCalendarMonth(focusedCalendarDate, direction)
      : shiftCalendarDate(focusedCalendarDate, direction * 7),
  );
  const clearDeviceData = async () => {
    if (clearingDeviceDataRef.current) return;
    clearingDeviceDataRef.current = true;
    if (navigator.onLine) await syncNow(db, fetch, setStatus).catch(() => {});
    stopSyncRef.current?.();
    stopSyncRef.current = undefined;
    const resumeSync = () => {
      stopSyncRef.current = startSyncLoop(setStatus, () => { void refresh(); });
    };
    await waitForSync(db).catch(() => {});
    let pendingChanges: number;
    try {
      pendingChanges = await db.outbox.count();
    } catch {
      setError(t.operationFailed);
      resumeSync();
      clearingDeviceDataRef.current = false;
      return;
    }
    if (!window.confirm(clearDeviceDataConfirmation(t, pendingChanges))) {
      resumeSync();
      clearingDeviceDataRef.current = false;
      return;
    }
    void clearLocalData().catch(() => {
      setError(t.operationFailed);
      clearingDeviceDataRef.current = false;
    });
  };

  return (
    <div className={styles.appShell}>
      <header className={styles.mobileHeader}>
        <button ref={menuButtonRef} className={styles.menuButton} type="button" aria-expanded={sidebarOpen} aria-controls="sidebar" aria-label={sidebarOpen ? t.closeNavigation : t.openNavigation} onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
        <span className={styles.mobileBrand}>{t.appName}</span>
        <span className={`${styles.statusDot} ${styles[`status${status}`]}`} aria-label={statusText} title={statusText} />
      </header>
      <aside id="sidebar" className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`} aria-label={t.navigation} aria-hidden={isMobile && !sidebarOpen} inert={isMobile && !sidebarOpen} onKeyDown={isMobile && sidebarOpen ? (event) => trapDialogFocus(event, () => setSidebarOpen(false)) : undefined}>
        <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true">t</span><span>{t.appName}</span></div>
        <nav className={styles.primaryNav} aria-label={t.views}>
          {([
            ["all", t.all], ["inbox", t.inbox], ["today", t.today], ["overdue", t.overdue], ["calendar", t.calendar], ["settings", t.settings],
          ] as const).map(([key, label]) => (
            <button ref={key === "all" ? firstNavigationItemRef : undefined} key={key} type="button" className={`${styles.navItem} ${view === key ? styles.active : ""}`} aria-current={view === key ? "page" : undefined} onClick={() => selectView(key)}>
              <span className={styles.navIcon} aria-hidden="true">{{ all: "◷", inbox: "▱", today: "◉", overdue: "◷", calendar: "▦", settings: "⚙" }[key]}</span>{label}
            </button>
          ))}
        </nav>
        <div className={styles.projectHeader}>
          <h2>{t.projects}</h2>
          <button type="button" className={styles.iconButton} aria-label={t.newProject} onClick={() => setNewProjectOpen(!newProjectOpen)}>＋</button>
        </div>
        <nav aria-label={t.projects} className={styles.projectNavigation}>
          {activeProjects.length ? renderProjectTree(null, activeProjects, selectedProjectId, (project) => selectView({ projectId: project.id }), t) : <p className={styles.mutedSmall}>{t.emptyProject}</p>}
        </nav>
        {newProjectOpen && (
          <form className={styles.newProjectForm} onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = String(form.get("name") ?? "");
            const parentId = String(form.get("parent_id") ?? "") || null;
            void act(async () => { await createProject(name, parentId); setNewProjectOpen(false); });
          }}>
            <label htmlFor="new-project-name">{t.projectName}</label>
            <input id="new-project-name" name="name" maxLength={MAX_TITLE_LENGTH} required autoFocus />
            <label htmlFor="new-project-parent">{t.parentProject}</label>
            <select id="new-project-parent" name="parent_id" defaultValue={selectedProjectId ?? ""}>
              <option value="">{t.rootProject}</option>
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <div className={styles.formActions}>
              <button type="button" className={styles.textButton} onClick={() => setNewProjectOpen(false)}>{t.cancel}</button>
              <button type="submit" className={styles.smallPrimary}>{t.newProject}</button>
            </div>
          </form>
        )}
        <div className={styles.sidebarFooter}>
          <button type="button" className={`${styles.navItem} ${view === "trash" ? styles.active : ""}`} aria-current={view === "trash" ? "page" : undefined} onClick={() => selectView("trash")}>
            <span className={styles.navIcon} aria-hidden="true">⌫</span>{t.trash}<span className={styles.navCount}>{trashedTasks.length + projects.filter(({ deleted_at }) => deleted_at !== null).length || ""}</span>
          </button>
          <div className={styles.syncStatus}>
            <span className={`${styles.statusDot} ${styles[`status${status}`]}`} aria-hidden="true" />
            <span>{statusText}</span>
          </div>
        </div>
      </aside>
      {sidebarOpen && <button className={styles.backdrop} type="button" aria-label={t.closeNavigation} onClick={() => setSidebarOpen(false)} />}

      <main className={styles.main} inert={isMobile && sidebarOpen}>
        <div className={styles.topbar}>
          <div className={styles.breadcrumb}>{t.appName}<span aria-hidden="true">/</span>{taskHeading(view, projects, t)}</div>
          <div className={styles.topbarActions}>
            {status === "reauth" ? <button type="button" className={styles.smallPrimary} onClick={() => window.location.reload()}>{t.login}</button> : null}
            {(status === "error" || status === "offline") && <button type="button" className={styles.textButton} onClick={() => { void syncNow(db, fetch, setStatus).then(refresh).catch(() => {}); }}>{t.retry}</button>}
            <span className={`${styles.statusPill} ${styles[`status${status}`]}`}><span className={styles.statusDot} />{statusText}</span>
          </div>
        </div>
        {status === "reauth" && <div className={styles.reauthBanner} role="alert"><span>{t.reauth}</span><button type="button" className={styles.smallPrimary} onClick={() => window.location.reload()}>{t.login}</button></div>}
        {status === "offline" && <div className={styles.offlineBanner} role="status">{t.offline}</div>}
        {error && <div className={styles.errorBanner} role="alert">{error}</div>}

        <section className={styles.content} aria-labelledby="view-title">
          <div className={styles.contentHeader}>
            <div>
              <p className={styles.eyebrow}>{view === "trash" ? t.deletedItems : t.workspace}</p>
              <h1 id="view-title">{taskHeading(view, projects, t)}</h1>
              {view !== "settings" && <p className={styles.subtitle}>{view === "trash" ? t.trashRetention : taskCountText(view === "calendar" ? selectedDayTasks.length : regularTasks.length)}</p>}
            </div>
            {view !== "trash" && view !== "settings" && (
              <div className={styles.listControls}>
                <label className={styles.completedToggle}><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />{t.completed}</label>
                <label className={styles.sortControl}>{t.sort}
                  <select value={currentSort} onChange={(event) => setCurrentSort(event.target.value as TaskSort)}>
                    {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>

          {typeof view !== "string" && selectedProject?.deleted_at === null && (
            <div className={styles.projectTools}>
              <span>{selectedProject.parent_id ? `↳ ${projects.find(({ id }) => id === selectedProject.parent_id)?.name ?? ""}` : t.projects}</span>
              <button type="button" className={styles.textButton} onClick={() => setEditingProjectId(selectedProject.id)}>{t.editProject}</button>
              <button type="button" className={styles.dangerButton} onClick={() => { void act(async () => { await deleteProject(selectedProject.id); setView("all"); }); }}>{t.delete}</button>
            </div>
          )}

          {view !== "trash" && view !== "calendar" && view !== "settings" && (
            <form className={styles.quickAdd} onSubmit={submitQuickTask}>
              <span className={styles.addMark} aria-hidden="true">＋</span>
              <label className={styles.srOnly} htmlFor="quick-task-title">{t.taskTitle}</label>
              <input id="quick-task-title" type="text" value={quickTitle} onChange={(event) => setQuickTitle(event.target.value)} placeholder={t.addTask} maxLength={MAX_TITLE_LENGTH} required />
              <button type="submit" className={styles.smallPrimary}>{t.addTask}</button>
            </form>
          )}

          {view === "trash" ? (
            <div className={styles.trashSections}>
              {trashedProjects.length > 0 && <section aria-labelledby="trash-projects"><h2 id="trash-projects" className={styles.sectionTitle}>{t.projects}</h2><ul className={styles.taskList}>{trashedProjects.map((project) => {
                const parent = projects.find(({ id }) => id === project.parent_id);
                const restoreBlocked = Boolean(parent && parent.deleted_at !== null && parent.deleted_batch_id !== project.deleted_batch_id);
                return (
                  <li key={project.id} className={styles.taskRow}>
                    <div className={styles.taskMain}><span className={styles.trashIcon} aria-hidden="true">▱</span><span className={styles.taskTitle}>{project.name}</span></div>
                    <div className={styles.taskMeta}><button type="button" className={styles.textButton} disabled={restoreBlocked} title={restoreBlocked ? t.restoreParentFirst : undefined} onClick={() => { void act(() => restoreProject(project.id)); }}>{t.restore}</button><button type="button" className={styles.dangerButton} onClick={() => { if (window.confirm(t.confirmPurge)) void act(() => purgeTrash("project", project.id)); }}>{t.purge}</button></div>
                  </li>
                );
              })}</ul></section>}
              {trashedTasks.length > 0 && <section aria-labelledby="trash-tasks"><h2 id="trash-tasks" className={styles.sectionTitle}>{t.tasks}</h2><ul className={styles.taskList}>{trashedTasks.map((task) => {
                const trashedProject = task.project_id === null ? null : projects.find((project) => project.id === task.project_id && project.deleted_at !== null);
                return <li key={task.id} className={styles.taskRow}>
                  <div className={styles.taskMain}><span className={styles.trashIcon} aria-hidden="true">○</span><span className={styles.taskTitle}>{task.title}</span>{trashedProject && <span className={styles.mutedSmall}>{trashedProject.name}</span>}</div>
                  <div className={styles.taskMeta}><button type="button" className={styles.textButton} disabled={Boolean(trashedProject)} onClick={() => { void act(() => restoreTask(task.id)); }}>{t.restore}</button><button type="button" className={styles.dangerButton} onClick={() => { if (window.confirm(t.confirmPurge)) void act(() => purgeTrash("task", task.id)); }}>{t.purge}</button></div>
                </li>;
              })}</ul></section>}
              {trashedProjects.length === 0 && trashedTasks.length === 0 && <div className={styles.emptyState}><span className={styles.emptyIcon} aria-hidden="true">⌫</span><h2>{t.emptyTrash}</h2><p>{t.trashRetention}</p></div>}
            </div>
          ) : view === "calendar" ? (
            <div className={styles.calendarPanel}>
              <div className={styles.calendarToolbar}>
                <button type="button" className={styles.textButton} aria-label={t.previousPeriod} onClick={() => moveCalendar(-1)}>←</button>
                <h2 aria-live="polite">{calendarTitle}</h2>
                <button type="button" className={styles.textButton} aria-label={t.nextPeriod} onClick={() => moveCalendar(1)}>→</button>
                <div className={styles.calendarModes}>
                  <button type="button" className={calendarMode === "month" ? styles.calendarModeActive : styles.textButton} aria-pressed={calendarMode === "month"} onClick={() => setCalendarMode("month")}>{t.monthView}</button>
                  <button type="button" className={calendarMode === "week" ? styles.calendarModeActive : styles.textButton} aria-pressed={calendarMode === "week"} onClick={() => setCalendarMode("week")}>{t.weekView}</button>
                </div>
              </div>
              <table className={styles.calendarTable}>
                <caption className={styles.srOnly}>{calendarTitle}</caption>
                <thead><tr>{weekdays.map((weekday, index) => <th key={index} scope="col">{weekday}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: calendarDates.length / 7 }, (_, row) => (
                    <tr key={row}>{calendarDates.slice(row * 7, row * 7 + 7).map((date) => {
                      const count = calendarCounts.get(date) ?? 0;
                      const dateValue = new Date(`${date}T12:00:00Z`);
                      return <td key={date}>
                        <button
                          type="button"
                          className={`${styles.calendarDay} ${date.slice(0, 7) !== monthDays ? styles.calendarOutside : ""} ${date === focusedCalendarDate ? styles.calendarSelected : ""}`}
                          aria-label={calendarDayLabel(date, count)}
                          aria-pressed={date === focusedCalendarDate}
                          onClick={() => setCalendarDate(date)}
                        >
                          <span>{dayFormatter.format(dateValue)}</span>
                          {count > 0 && <span className={styles.calendarCount} aria-hidden="true">{count}</span>}
                        </button>
                      </td>;
                    })}</tr>
                  ))}
                </tbody>
              </table>
              <section className={styles.calendarTasks} aria-labelledby="selected-day-tasks">
                <h2 id="selected-day-tasks">{t.selectedDayTasks}: <time dateTime={focusedCalendarDate}>{fullDateFormatter.format(new Date(`${focusedCalendarDate}T12:00:00Z`))}</time></h2>
                {selectedDayTasks.length > 0
                  ? <ul className={styles.taskList} aria-label={t.selectedDayTasks}>{selectedDayTasks.map(renderRegularTask)}</ul>
                  : <p className={styles.mutedSmall}>{t.noTasksOnDate}</p>}
              </section>
            </div>
          ) : view === "settings" ? (
            <div className={styles.settingsPanel}>
              <label htmlFor="settings-timezone">{t.timezone}</label>
              <select id="settings-timezone" value={timezone} onChange={(event) => { void act(() => updateSettings({ timezone: event.target.value })); }}>
                {timezoneValues.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <label htmlFor="settings-locale">{t.language}</label>
              <select id="settings-locale" value={locale} onChange={(event) => { void act(() => updateSettings({ locale: event.target.value as Locale })); }}>
                <option value="ja">{t.japanese}</option>
                <option value="en">{t.english}</option>
              </select>
              <label htmlFor="settings-digest-time">{t.digestTime}</label>
              <input id="settings-digest-time" type="time" value={digestTime} onChange={(event) => { void act(() => updateSettings({ digest_time: event.target.value })); }} />
              <div className={styles.formActions}>
                <button type="button" className={styles.dangerButton} disabled={!ready} onClick={clearDeviceData}>{t.clearDeviceData}</button>
              </div>
            </div>
          ) : (
            <>
              <ul className={styles.taskList} aria-label={taskHeading(view, projects, t)}>
                {regularTasks.map(renderRegularTask)}
              </ul>
              {regularTasks.length === 0 && <div className={styles.emptyState}><span className={styles.emptyIcon} aria-hidden="true">✓</span><h2>{t.noTasks}</h2><p>{t.emptyTasksHelp}</p></div>}
            </>
          )}

          {editingTask && view !== "trash" && (
            <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingTaskId(null); }}>
              <section className={styles.editor} role="dialog" aria-modal="true" aria-labelledby="edit-task-heading" onKeyDown={(event) => trapDialogFocus(event, () => setEditingTaskId(null))}>
                <div className={styles.editorHeading}><h2 id="edit-task-heading">{t.edit}</h2><button type="button" className={styles.iconButton} aria-label={t.close} onClick={() => setEditingTaskId(null)}>×</button></div>
                <form key={editingTask.id} onSubmit={(event) => submitTaskEdit(event, editingTask)}>
                  <label htmlFor="edit-task-title">{t.taskTitle}</label>
                  <input id="edit-task-title" name="title" defaultValue={editingTask.title} maxLength={MAX_TITLE_LENGTH} required autoFocus />
                  <label className={styles.checkboxField}><input name="done" type="checkbox" defaultChecked={editingTask.done} />{t.done}</label>
                  <div className={styles.fieldGrid}>
                    <div><label htmlFor="edit-task-date">{t.dueDate}</label><input id="edit-task-date" name="due_date" type="date" defaultValue={editingTask.due_date ?? ""} /></div>
                    <div><label htmlFor="edit-task-time">{t.dueTime}</label><input id="edit-task-time" name="due_time" type="time" defaultValue={editingTask.due_time ?? ""} /></div>
                  </div>
                  <label htmlFor="edit-task-note">{t.note}</label><textarea id="edit-task-note" name="note" defaultValue={editingTask.note} maxLength={MAX_NOTE_LENGTH} rows={4} />
                  <label htmlFor="edit-task-priority">{t.priority}</label>
                  <select id="edit-task-priority" name="priority" defaultValue={editingTask.priority}>
                    {priorityLabels.map((label, value) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <label htmlFor="edit-task-project">{t.project}</label>
                  <select id="edit-task-project" name="project_id" defaultValue={editingTask.project_id ?? ""}>
                    <option value="">{t.noProject}</option>
                    {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                  <div className={styles.formActions}><button type="button" className={styles.textButton} onClick={() => setEditingTaskId(null)}>{t.cancel}</button><button type="submit" className={styles.primaryButton}>{t.save}</button></div>
                </form>
              </section>
            </div>
          )}

          {editingProject && (
            <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingProjectId(null); }}>
              <section className={styles.editor} role="dialog" aria-modal="true" aria-labelledby="edit-project-heading" onKeyDown={(event) => trapDialogFocus(event, () => setEditingProjectId(null))}>
                <div className={styles.editorHeading}><h2 id="edit-project-heading">{t.editProject}</h2><button type="button" className={styles.iconButton} aria-label={t.close} onClick={() => setEditingProjectId(null)}>×</button></div>
                <form key={editingProject.id} onSubmit={(event) => submitProjectEdit(event, editingProject)}>
                  <label htmlFor="edit-project-name">{t.projectName}</label><input id="edit-project-name" name="name" defaultValue={editingProject.name} maxLength={MAX_TITLE_LENGTH} required autoFocus />
                  <label htmlFor="edit-project-parent">{t.parentProject}</label>
                  <select id="edit-project-parent" name="parent_id" defaultValue={editingProject.parent_id ?? ""}>
                    <option value="">{t.rootProject}</option>
                    {activeProjects.filter((project) => project.id !== editingProject.id && !descendants(editingProject.id, activeProjects).has(project.id)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                  <div className={styles.formActions}><button type="button" className={styles.textButton} onClick={() => setEditingProjectId(null)}>{t.cancel}</button><button type="submit" className={styles.primaryButton}>{t.save}</button></div>
                </form>
              </section>
            </div>
          )}
        </section>
        {!ready && <div className={styles.loading} role="status">{t.loading}</div>}
      </main>
    </div>
  );
}
