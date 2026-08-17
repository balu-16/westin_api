-- Events gain an optional description (the portal event form collects one).
alter table if exists events add column if not exists description text;
