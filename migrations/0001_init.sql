CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','lecturer')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  lecturer_id TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  lecturer_id TEXT NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  room_lat REAL,
  room_lng REAL,
  radius_m INTEGER DEFAULT 50
);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  scanned_at INTEGER NOT NULL,
  ip TEXT,
  lat REAL,
  lng REAL,
  UNIQUE(session_id, user_id)
);
