CREATE TABLE laser_separation_new (
  machine TEXT NOT NULL,
  program TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'reschedule', 'missing_material', 'awaiting_pcp')),
  PRIMARY KEY (machine, program)
);

INSERT INTO laser_separation_new (machine, program, status)
SELECT machine, program, status FROM laser_separation;

DROP TABLE laser_separation;
ALTER TABLE laser_separation_new RENAME TO laser_separation;
