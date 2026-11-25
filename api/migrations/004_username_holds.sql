-- username বদলানোর জন্য, একবার চালান (আবার চালালেও ক্ষতি নেই)
CREATE TABLE IF NOT EXISTS username_holds (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL,
  until INTEGER NOT NULL
);
