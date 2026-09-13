-- Manual seed data for local development/testing (Phase 1).
-- password_hash values are placeholders — Phase 3 (auth) introduces real
-- PBKDF2 hashing; these rows exist only to have foreign keys to point at
-- until then.
INSERT INTO users (id, name, email, password_hash, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Dana Lecturer', 'lecturer@example.com', 'placeholder-hash', 'lecturer'),
  ('22222222-2222-2222-2222-222222222222', 'Sam Student', 'student@example.com', 'placeholder-hash', 'student');
