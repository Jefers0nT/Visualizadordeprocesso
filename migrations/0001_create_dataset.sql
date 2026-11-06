CREATE TABLE dataset_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dataset_chunks (
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ops', 'ordens')),
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, chunk_index),
  FOREIGN KEY (snapshot_id) REFERENCES dataset_snapshots(snapshot_id) ON DELETE CASCADE
);

CREATE TABLE active_dataset (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  snapshot_id TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES dataset_snapshots(snapshot_id)
);

CREATE TABLE login_attempts (
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX login_attempts_ip_time ON login_attempts (ip_hash, attempted_at);
