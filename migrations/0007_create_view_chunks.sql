CREATE TABLE dataset_view_chunks (
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ops', 'ordens', 'apontamentos')),
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, chunk_index),
  FOREIGN KEY (snapshot_id) REFERENCES dataset_snapshots(snapshot_id) ON DELETE CASCADE
);
