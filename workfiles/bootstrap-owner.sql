-- Out-of-band first owner. Sign-in stays invite-only; this is not a signup path.
-- Applied to production CONTROL_DB on 2026-08-28.
-- Preview already had jorge@pox.me as owner of workspace ws-beta-eventforge.
insert into workspaces (id, name, plan, created_at)
values (
  '77fe6619-8b20-4310-a7f6-5382ae0c518e',
  'EventForge',
  'developer',
  '2026-08-28T00:00:00.000Z'
)
on conflict(id) do nothing;

insert into identities (id, normalized_email, created_at)
values (
  'dc5a545d-f449-49d1-80b3-0503aeff1766',
  'jorge@pox.me',
  '2026-08-28T00:00:00.000Z'
)
on conflict(normalized_email) do nothing;

insert into workspace_memberships (
  workspace_id, identity_id, role, version, created_at, updated_at
)
values (
  '77fe6619-8b20-4310-a7f6-5382ae0c518e',
  'dc5a545d-f449-49d1-80b3-0503aeff1766',
  'owner',
  1,
  '2026-08-28T00:00:00.000Z',
  '2026-08-28T00:00:00.000Z'
)
on conflict(workspace_id, identity_id) do nothing;
