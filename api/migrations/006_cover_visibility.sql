-- কভার ফটো ও অনলাইন স্ট্যাটাস কে দেখবে ('all' সবাই, 'contacts' যাদের সঙ্গে চ্যাট হয়েছে, 'me' শুধু আমি), শুধু একবার চালান
ALTER TABLE users ADD COLUMN cover TEXT;
ALTER TABLE users ADD COLUMN online_vis TEXT NOT NULL DEFAULT 'all';
CREATE TABLE IF NOT EXISTS contacts (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
