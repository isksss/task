ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;

ALTER TABLE tasks ADD COLUMN recurrence TEXT CHECK (
  recurrence IS NULL
  OR json_valid(recurrence)
);

CREATE INDEX IF NOT EXISTS tasks_user_parent_task ON tasks (user_id, parent_task_id);

CREATE TRIGGER IF NOT EXISTS tasks_parent_insert_check BEFORE INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND id = NEW.parent_task_id
    ) THEN RAISE (ABORT, 'parent_task_not_found') END;

SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND id = NEW.parent_task_id
        AND parent_task_id IS NOT NULL
    ) THEN RAISE (ABORT, 'subtask_cannot_be_parent') END;

SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND parent_task_id = NEW.id
    ) THEN RAISE (ABORT, 'task_with_subtasks_cannot_be_subtask') END;

END;

CREATE TRIGGER IF NOT EXISTS tasks_parent_update_check BEFORE
UPDATE OF parent_task_id ON tasks WHEN NEW.parent_task_id IS NOT OLD.parent_task_id
AND NEW.parent_task_id IS NOT NULL BEGIN
SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND id = NEW.parent_task_id
    ) THEN RAISE (ABORT, 'parent_task_not_found') END;

SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND id = NEW.parent_task_id
        AND parent_task_id IS NOT NULL
    ) THEN RAISE (ABORT, 'subtask_cannot_be_parent') END;

SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        tasks
      WHERE
        user_id = NEW.user_id
        AND parent_task_id = NEW.id
    ) THEN RAISE (ABORT, 'task_with_subtasks_cannot_be_subtask') END;

END;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 500),
  deleted_at TEXT,
  field_ts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_ts)),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

CREATE INDEX IF NOT EXISTS tags_user_seq ON tags (user_id, seq);

CREATE INDEX IF NOT EXISTS tags_user_deleted ON tags (user_id, deleted_at);

CREATE TABLE IF NOT EXISTS task_tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  field_ts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_ts)),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

CREATE INDEX IF NOT EXISTS task_tags_user_seq ON task_tags (user_id, seq);

CREATE INDEX IF NOT EXISTS task_tags_user_task ON task_tags (user_id, task_id);

CREATE INDEX IF NOT EXISTS task_tags_user_tag ON task_tags (user_id, tag_id);

CREATE TABLE IF NOT EXISTS tombstones_v2 (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('task', 'project', 'tag')),
  id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (user_id, entity, id)
);

INSERT INTO
  tombstones_v2 (user_id, entity, id, purged_at, seq)
SELECT
  user_id,
  entity,
  id,
  purged_at,
  seq
FROM
  tombstones;

DROP TABLE tombstones;

ALTER TABLE tombstones_v2
RENAME TO tombstones;

CREATE INDEX IF NOT EXISTS tombstones_user_seq ON tombstones (user_id, seq);

CREATE INDEX IF NOT EXISTS tombstones_user_purged ON tombstones (user_id, purged_at);