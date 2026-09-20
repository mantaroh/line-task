ALTER TABLE members ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE members ADD COLUMN party  TEXT;              -- NULL ならすべて

CREATE TABLE notification_log (
  line_user_id  TEXT NOT NULL REFERENCES users(line_user_id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_key      TEXT NOT NULL,                           -- タスク ID（無ければ row-N）
  kind          TEXT NOT NULL,                           -- before / due / after3
  due           TEXT NOT NULL,                           -- yyyy-mm-dd
  sent_at       TEXT NOT NULL,
  PRIMARY KEY (line_user_id, project_id, task_key, kind, due)
);
CREATE INDEX notification_log_sent_at ON notification_log(sent_at);
