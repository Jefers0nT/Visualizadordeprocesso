CREATE TABLE laser_separation (
  machine TEXT NOT NULL,
  program TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid')),
  PRIMARY KEY (machine, program)
);
