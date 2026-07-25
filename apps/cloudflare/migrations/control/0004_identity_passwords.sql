-- Password credentials for hosted sign-in.
--
-- Kept in a separate table rather than columns on `identities` so a credential can
-- be revoked or rotated without touching the identity row, and so an identity may
-- exist with no password at all (the email-link path remains the recovery route).
--
-- The algorithm and iteration count are stored per row. A future increase must be
-- able to re-hash on next successful sign-in without guessing how an existing
-- hash was produced.
create table if not exists identity_passwords (
  identity_id text primary key references identities(id),
  algorithm text not null check (algorithm in ('pbkdf2-sha256')),
  iterations integer not null check (iterations >= 100000),
  salt text not null,
  hash text not null,
  updated_at text not null,
  created_at text not null
);

-- Failed sign-in attempts, used to lock an account out before a password can be
-- guessed. Turnstile raises the cost of automation but does not bound attempts on
-- its own, so the server keeps its own counter.
create table if not exists identity_login_attempts (
  identity_id text primary key references identities(id),
  failed_count integer not null default 0,
  first_failed_at text,
  locked_until text
);
