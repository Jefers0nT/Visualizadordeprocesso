ALTER TABLE dataset_snapshots ADD COLUMN upload_expected_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dataset_snapshots ADD COLUMN upload_received_bytes INTEGER NOT NULL DEFAULT 0;
