-- DROP TABLE arena.comment_only_example;
/*
 * TRUNCATE TABLE arena.another_comment_only_example;
 * ALTER TABLE arena.accounts DROP COLUMN comment_only_column;
 */

CREATE TABLE arena.new_accounts (
  id bigint PRIMARY KEY,
  handle text NOT NULL
);

ALTER TABLE arena.accounts
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN nickname text,
  ADD CONSTRAINT nickname_is_present CHECK (nickname IS NOT NULL);

ALTER TABLE arena.accounts
  ALTER COLUMN score SET DEFAULT 0,
  ALTER COLUMN score SET NOT NULL;
