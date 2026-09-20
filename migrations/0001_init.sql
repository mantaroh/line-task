CREATE TABLE users (
  line_user_id  TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  picture_url   TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,        -- 10 文字のランダム（URL に出る）
  name            TEXT NOT NULL,
  parties         TEXT NOT NULL,           -- JSON 配列 ["A社","自社"]
  spreadsheet_id  TEXT,                    -- 未接続なら NULL
  next_task_no    INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL REFERENCES users(line_user_id),
  created_at      TEXT NOT NULL,
  archived_at     TEXT
);

-- 1 度つないだシートは、そのプロジェクト専用になる（行を消さない）
CREATE TABLE sheet_bindings (
  spreadsheet_id  TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  bound_at        TEXT NOT NULL
);

CREATE TABLE members (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  line_user_id  TEXT NOT NULL REFERENCES users(line_user_id),
  joined_at     TEXT NOT NULL,
  joined_via    TEXT NOT NULL,             -- 'create' か invites.id
  PRIMARY KEY (project_id, line_user_id)
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256。トークンそのものは保存しない
  project_id  TEXT NOT NULL REFERENCES projects(id),
  created_by  TEXT NOT NULL REFERENCES users(line_user_id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  use_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  actor       TEXT NOT NULL,               -- line_user_id
  action      TEXT NOT NULL,               -- 下の表
  detail      TEXT,                        -- JSON（変更前後の値など）
  at          TEXT NOT NULL
);
CREATE INDEX activity_project_at ON activity(project_id, at DESC);
