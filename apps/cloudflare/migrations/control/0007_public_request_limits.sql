CREATE TABLE public_request_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX public_request_limits_expiry ON public_request_limits(expires_at);
