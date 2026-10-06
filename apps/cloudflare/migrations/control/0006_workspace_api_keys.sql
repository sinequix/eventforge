-- Machine credentials. Default permission is none; each resource is independently read/write.
create table if not exists workspace_api_keys (
  id text primary key,
  workspace_id text not null references workspaces(id),
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  events_permission text not null default 'none' check (events_permission in ('none','read','write')),
  destinations_permission text not null default 'none' check (destinations_permission in ('none','read','write')),
  deliveries_permission text not null default 'none' check (deliveries_permission in ('none','read','write')),
  replay_permission text not null default 'none' check (replay_permission in ('none','read','write')),
  created_by_identity_id text references identities(id),
  last_used_at text,
  revoked_at text,
  created_at text not null,
  unique (workspace_id, id)
);

create index if not exists workspace_api_keys_workspace_idx
  on workspace_api_keys(workspace_id, revoked_at);
