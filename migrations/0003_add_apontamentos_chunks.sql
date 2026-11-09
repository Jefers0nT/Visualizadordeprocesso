CREATE TABLE dataset_chunks_new (
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ops', 'ordens', 'apontamentos')),
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, chunk_index),
  FOREIGN KEY (snapshot_id) REFERENCES dataset_snapshots(snapshot_id) ON DELETE CASCADE
);

INSERT INTO dataset_chunks_new (snapshot_id, kind, chunk_index, payload)
SELECT snapshot_id, kind, chunk_index, payload FROM dataset_chunks;

DROP TABLE dataset_chunks;
ALTER TABLE dataset_chunks_new RENAME TO dataset_chunks;
