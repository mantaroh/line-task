-- タスクの動画・音声（docs/設計書_動画音声_20260917.md §3）
CREATE TABLE task_media (
  id            TEXT PRIMARY KEY,                       -- 16 文字のランダム（[0-9a-z]）
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT NOT NULL,                          -- T-012
  kind          TEXT NOT NULL,                          -- video / audio
  content_type  TEXT NOT NULL,                          -- 先頭のバイトで判定した値
  size          INTEGER NOT NULL,                       -- バイト数
  duration_ms   INTEGER,                                -- 端末で測った長さ。測れなければ NULL
  has_thumb     INTEGER NOT NULL DEFAULT 0,             -- 1 = サムネイルあり
  created_by    TEXT NOT NULL REFERENCES users(line_user_id),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX task_media_task ON task_media(project_id, task_id, created_at);
