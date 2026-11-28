-- লিঙ্গ ও জন্ম তারিখ সিস্টেম বাদ: আগে জমা থাকা সব ডেটা মুছে ফেলে।
-- শুধু তখনই চালান যদি আগে 005/006-এর পুরনো সংস্করণ চালিয়ে থাকেন (যেগুলো এই কলামগুলো বানিয়েছিল)।
-- D1 Console-এ এক-একটা লাইন আলাদা চালান; "no such column" এলে সেই লাইন বাদ দিন (কলাম আগেই নেই)।
ALTER TABLE users DROP COLUMN gender;
ALTER TABLE users DROP COLUMN birth_date;
ALTER TABLE users DROP COLUMN gender_vis;
ALTER TABLE users DROP COLUMN birth_vis;
