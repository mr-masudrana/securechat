-- আগে থেকে চালু ডাটাবেজের জন্য (শুধু একবার চালান; নতুন ডাটাবেজে schema.sql-ই যথেষ্ট)
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN full_name TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN profile_done INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE TABLE IF NOT EXISTS otps (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  full_name TEXT,
  pass_hash TEXT,
  salt TEXT,
  PRIMARY KEY (email, purpose)
);
