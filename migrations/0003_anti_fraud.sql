CREATE TABLE attendance_flags (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_attendance_flags_session_id ON attendance_flags(session_id);

-- One row per (ip, minute bucket); count is incremented atomically on each
-- POST /api/attend. Rows are never purged automatically — see README.
CREATE TABLE attend_rate_limits (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
