-- ব্লক ফিচার ও দ্রুত কোয়েরির জন্য ইনডেক্স (আবার চালালেও ক্ষতি নেই)
CREATE TABLE IF NOT EXISTS blocks (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_user ON ws_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_b ON contacts(b);
CREATE INDEX IF NOT EXISTS idx_blocks_b ON blocks(b);
