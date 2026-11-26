-- Bio, লিঙ্গ ও জন্ম তারিখের জন্য, শুধু একবার চালান
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN gender TEXT;
ALTER TABLE users ADD COLUMN birth_date TEXT;
