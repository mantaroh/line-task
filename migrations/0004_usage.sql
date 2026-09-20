CREATE TABLE access_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,                          -- +09:00 付きの日時
  line_user_id  TEXT NOT NULL REFERENCES users(line_user_id),
  project_id    TEXT,                                   -- ホーム・新規作成・招待は NULL
  view          TEXT NOT NULL                           -- 下の表
);
CREATE INDEX access_log_at ON access_log(at);
ALTER TABLE users ADD COLUMN line_friend INTEGER;             -- 1 = 友だち、0 = 友だちでない、NULL = 未確認
ALTER TABLE users ADD COLUMN line_friend_checked_at TEXT;
