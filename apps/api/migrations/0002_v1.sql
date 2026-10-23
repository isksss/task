CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  access_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  locale TEXT NOT NULL DEFAULT 'ja' CHECK (locale IN ('ja', 'en')),
  digest_time TEXT NOT NULL DEFAULT '08:00',
  field_ts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_ts)),
  seq_counter INTEGER NOT NULL DEFAULT 1 CHECK (seq_counter >= 0),
  settings_seq INTEGER NOT NULL DEFAULT 1 CHECK (settings_seq >= 0),
  tombstone_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (tombstone_floor_seq >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id TEXT,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 500),
  deleted_at TEXT,
  deleted_batch_id TEXT,
  field_ts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_ts)),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

CREATE INDEX IF NOT EXISTS projects_user_seq ON projects (user_id, seq);

CREATE INDEX IF NOT EXISTS projects_user_parent ON projects (user_id, parent_id);

CREATE INDEX IF NOT EXISTS projects_user_deleted ON projects (user_id, deleted_at);

CREATE TRIGGER IF NOT EXISTS projects_parent_insert_check BEFORE INSERT ON projects WHEN NEW.parent_id IS NOT NULL BEGIN
SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT
        1
      FROM
        projects
      WHERE
        id = NEW.parent_id
        AND user_id = NEW.user_id
    ) THEN RAISE (ABORT, 'parent_not_found') END;

SELECT
  CASE
    WHEN EXISTS (
      WITH RECURSIVE
        ancestors (id, parent_id, depth, path) AS (
          SELECT
            id,
            parent_id,
            1,
            '/' || id || '/'
          FROM
            projects
          WHERE
            id = NEW.parent_id
            AND user_id = NEW.user_id
          UNION ALL
          SELECT
            p.id,
            p.parent_id,
            a.depth + 1,
            a.path || p.id || '/'
          FROM
            projects p
            JOIN ancestors a ON a.parent_id = p.id
          WHERE
            p.user_id = NEW.user_id
            AND instr(a.path, '/' || p.id || '/') = 0
            AND a.depth < 4
        )
      SELECT
        1
      FROM
        ancestors
      WHERE
        id = NEW.id
    ) THEN RAISE (ABORT, 'project_cycle') END;

SELECT
  CASE
    WHEN (
      WITH RECURSIVE
        ancestors (id, parent_id, depth, path) AS (
          SELECT
            id,
            parent_id,
            1,
            '/' || id || '/'
          FROM
            projects
          WHERE
            id = NEW.parent_id
            AND user_id = NEW.user_id
          UNION ALL
          SELECT
            p.id,
            p.parent_id,
            a.depth + 1,
            a.path || p.id || '/'
          FROM
            projects p
            JOIN ancestors a ON a.parent_id = p.id
          WHERE
            p.user_id = NEW.user_id
            AND instr(a.path, '/' || p.id || '/') = 0
            AND a.depth < 4
        )
      SELECT
        COALESCE(MAX(depth), 0) + 1
      FROM
        ancestors
    ) > 3 THEN RAISE (ABORT, 'project_depth_exceeded') END;

END;

CREATE TRIGGER IF NOT EXISTS projects_parent_update_check BEFORE
UPDATE OF parent_id ON projects WHEN NEW.parent_id IS NOT OLD.parent_id
AND NEW.parent_id IS NOT NULL BEGIN
SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT
        1
      FROM
        projects
      WHERE
        id = NEW.parent_id
        AND user_id = NEW.user_id
    ) THEN RAISE (ABORT, 'parent_not_found') END;

SELECT
  CASE
    WHEN EXISTS (
      SELECT
        1
      FROM
        projects
      WHERE
        id = NEW.parent_id
        AND user_id = NEW.user_id
        AND deleted_at IS NOT NULL
    ) THEN RAISE (ABORT, 'parent_deleted') END;

SELECT
  CASE
    WHEN EXISTS (
      WITH RECURSIVE
        ancestors (id, parent_id, depth, path) AS (
          SELECT
            id,
            parent_id,
            1,
            '/' || id || '/'
          FROM
            projects
          WHERE
            id = NEW.parent_id
            AND user_id = NEW.user_id
          UNION ALL
          SELECT
            p.id,
            p.parent_id,
            a.depth + 1,
            a.path || p.id || '/'
          FROM
            projects p
            JOIN ancestors a ON a.parent_id = p.id
          WHERE
            p.user_id = NEW.user_id
            AND instr(a.path, '/' || p.id || '/') = 0
            AND a.depth < 4
        )
      SELECT
        1
      FROM
        ancestors
      WHERE
        id = NEW.id
    ) THEN RAISE (ABORT, 'project_cycle') END;

SELECT
  CASE
    WHEN (
      WITH RECURSIVE
        ancestors (id, parent_id, depth, path) AS (
          SELECT
            id,
            parent_id,
            1,
            '/' || id || '/'
          FROM
            projects
          WHERE
            id = NEW.parent_id
            AND user_id = NEW.user_id
          UNION ALL
          SELECT
            p.id,
            p.parent_id,
            a.depth + 1,
            a.path || p.id || '/'
          FROM
            projects p
            JOIN ancestors a ON a.parent_id = p.id
          WHERE
            p.user_id = NEW.user_id
            AND instr(a.path, '/' || p.id || '/') = 0
            AND a.depth < 4
        ),
        descendants (id, depth, path) AS (
          SELECT
            id,
            1,
            '/' || id || '/'
          FROM
            projects
          WHERE
            id = NEW.id
            AND user_id = NEW.user_id
          UNION ALL
          SELECT
            child.id,
            d.depth + 1,
            d.path || child.id || '/'
          FROM
            projects child
            JOIN descendants d ON child.parent_id = d.id
          WHERE
            child.user_id = NEW.user_id
            AND instr(d.path, '/' || child.id || '/') = 0
            AND d.depth < 4
        ),
        ancestor_depth AS (
          SELECT
            COALESCE(MAX(depth), 0) AS depth
          FROM
            ancestors
        ),
        subtree_depth AS (
          SELECT
            COALESCE(MAX(depth), 1) AS depth
          FROM
            descendants
        )
      SELECT
        ancestor_depth.depth + subtree_depth.depth
      FROM
        ancestor_depth,
        subtree_depth
    ) > 3 THEN RAISE (ABORT, 'project_depth_exceeded') END;

END;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 20000),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  due_date TEXT,
  due_time TEXT,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  deleted_batch_id TEXT,
  field_ts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_ts)),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

CREATE INDEX IF NOT EXISTS tasks_user_seq ON tasks (user_id, seq);

CREATE INDEX IF NOT EXISTS tasks_user_project ON tasks (user_id, project_id);

CREATE INDEX IF NOT EXISTS tasks_user_deleted ON tasks (user_id, deleted_at);

CREATE TABLE IF NOT EXISTS tombstones (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('task', 'project')),
  id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (user_id, entity, id)
);

CREATE INDEX IF NOT EXISTS tombstones_user_seq ON tombstones (user_id, seq);

CREATE INDEX IF NOT EXISTS tombstones_user_purged ON tombstones (user_id, purged_at);

CREATE TABLE IF NOT EXISTS applied_changes (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, change_id)
);

CREATE INDEX IF NOT EXISTS applied_changes_applied_at ON applied_changes (applied_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS notification_log (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions (id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, slot_key)
);

CREATE INDEX IF NOT EXISTS notification_log_sent_at ON notification_log (sent_at);