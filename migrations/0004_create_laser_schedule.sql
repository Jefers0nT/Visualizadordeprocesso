CREATE TABLE laser_schedule (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
