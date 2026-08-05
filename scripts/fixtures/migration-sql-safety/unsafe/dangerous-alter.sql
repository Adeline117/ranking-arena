ALTER TABLE arena.accounts DROP COLUMN legacy_score;
ALTER TABLE arena.accounts DROP CONSTRAINT accounts_handle_key;
ALTER TABLE arena.accounts ALTER COLUMN score TYPE numeric(30, 10);
ALTER TABLE arena.accounts RENAME COLUMN handle TO username;
ALTER TABLE arena.accounts SET SCHEMA private;
ALTER TABLE arena.account_events DETACH PARTITION arena.account_events_2025;
ALTER TABLE arena.accounts DISABLE TRIGGER USER;
