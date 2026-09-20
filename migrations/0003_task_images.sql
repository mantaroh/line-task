CREATE TABLE task_images (
  id            TEXT PRIMARY KEY,                       -- 16 文字のランダム（[0-9a-z]）
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT NOT NULL,                          -- T-012
  size          INTEGER NOT NULL,                       -- 本体のバイト数
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(line_user_id),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT                                    -- 削除したら日時を入れる
);
CREATE INDEX task_images_task ON task_images(project_id, task_id, created_at);
