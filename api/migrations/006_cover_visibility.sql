-- কভার ফটো, লিঙ্গ/জন্ম তারিখ/অনলাইন স্ট্যাটাস কে দেখবে ('all' সবাই, 'contacts' যাদের সঙ্গে চ্যাট হয়েছে, 'me' শুধু আমি), শুধু একবার চালান
ALTER TABLE users ADD COLUMN cover TEXT;
ALTER TABLE users ADD COLUMN gender_vis TEXT NOT NULL DEFAULT 'me';
ALTER TABLE users ADD COLUMN birth_vis TEXT NOT NULL DEFAULT 'me';
ALTER TABLE users ADD COLUMN online_vis TEXT NOT NULL DEFAULT 'all';
CREATE TABLE IF NOT EXISTS contacts (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
