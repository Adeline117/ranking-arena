ALTER TABLE arena.accounts
  ADD COLUMN enabled boolean NOT NULL;

ALTER TABLE arena.accounts
  ALTER COLUMN score SET NOT NULL;

ALTER TABLE arena.accounts
  ADD COLUMN quota bigint DEFAULT 0,
  ADD COLUMN region text NOT NULL;
