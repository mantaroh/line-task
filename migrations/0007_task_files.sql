-- タスクのファイル添付（docs/設計書_ファイル_20260920.md §3）
CREATE TABLE task_files (
  id            TEXT PRIMARY KEY,                       -- 16 文字のランダム（[0-9a-z]）
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT NOT NULL,                          -- T-012
  file_name     TEXT NOT NULL,                          -- 画面に出す名前。255 文字まで
  content_type  TEXT NOT NULL,                          -- 先頭バイトと拡張子から決めた値
  size          INTEGER NOT NULL,                       -- バイト数
  created_by    TEXT NOT NULL REFERENCES users(line_user_id),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX task_files_task ON task_files(project_id, task_id, created_at);
