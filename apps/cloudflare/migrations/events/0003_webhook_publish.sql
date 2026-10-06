create table if not exists webhook_messages (
  id text primary key,
  workspace_id text not null,
  installation_id text not null,
  event_type text not null,
  channel text,
  idempotency_key text not null,
  payload_ref text not null,
  payload_checksum text not null,
  payload_bytes integer not null,
  matched_destination_count integer not null default 0,
  status text not null check (status in ('stored','enqueued','no_match')),
  created_at text not null,
  unique (workspace_id, idempotency_key),
  unique (workspace_id, id)
);

create table if not exists publish_idempotency (
  workspace_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer not null,
  response_body text not null,
  created_at text not null,
  primary key (workspace_id, idempotency_key)
);

create table if not exists inbound_rate_counters (
  bucket_key text not null,
  window_start text not null,
  count integer not null,
  primary key (bucket_key, window_start)
);

create table if not exists outbound_rate_counters (
  destination_id text not null,
  window_start integer not null,
  count integer not null,
  primary key (destination_id, window_start)
);

alter table deliveries add column destination_id text;
alter table deliveries add column event_id text;
alter table delivery_attempts add column response_code integer;
alter table delivery_attempts add column latency_ms integer;

create index if not exists deliveries_destination_idx on deliveries(workspace_id, destination_id);
create index if not exists deliveries_event_idx on deliveries(workspace_id, event_id);
create index if not exists webhook_messages_workspace_idx on webhook_messages(workspace_id, created_at desc);
