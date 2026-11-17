-- Discovery presets are multi-select: a tenant can switch on several built-in presets
-- (e.g. india + global-remote). The legacy single `discovery_preset` stays as the fallback
-- when the list is empty, so existing rows keep their behaviour.
alter table tenant_config
  add column if not exists discovery_presets text[] not null default '{}';
