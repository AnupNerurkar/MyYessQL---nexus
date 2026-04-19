const db = require('./db');

db.exec(`PRAGMA foreign_keys=OFF;`);

db.exec(`
  BEGIN;
  CREATE TABLE IF NOT EXISTS dues_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    department TEXT NOT NULL DEFAULT 'Library',
    amount REAL NOT NULL,
    description TEXT DEFAULT 'Due',
    status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO dues_new SELECT id, student_id, COALESCE(department,'Library'), amount, COALESCE(description,'Due'), status, created_at FROM dues;
  DROP TABLE dues;
  ALTER TABLE dues_new RENAME TO dues;
  COMMIT;
`);

db.exec(`PRAGMA foreign_keys=ON;`);

console.log('Migration done.');
console.log(db.prepare('PRAGMA table_info(dues)').all().map(c => c.name + ' | dflt=' + c.dflt_value + ' | notnull=' + c.notnull).join('\n'));
