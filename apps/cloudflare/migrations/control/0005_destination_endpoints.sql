-- Destinations hang off a verified installation (the route), not a parallel app_id.
create table if not exists destination_endpoints (
  id text primary key,
  workspace_id text not null,
  installation_id text not null,
  url text not null,
  description text not null default '',
  secret_ciphertext text not null,
  secret_nonce text not null,
  previous_secret_ciphertext text,
  previous_secret_nonce text,
  secret_hint text not null,
  event_types text not null default '[]',
  channels text not null default '[]',
  max_rate_per_second integer not null default 10 check (max_rate_per_second > 0 and max_rate_per_second <= 1000),
  mode text not null default 'best_effort' check (mode in ('best_effort','fifo')),
  status text not null default 'active' check (status in ('active','paused','disabled')),
  created_at text not null,
  updated_at text not null,
  unique (workspace_id, id),
  foreign key (workspace_id, installation_id) references delivery_installations(workspace_id, id)
);

create index if not exists destination_endpoints_installation_idx
  on destination_endpoints(workspace_id, installation_id, status);
