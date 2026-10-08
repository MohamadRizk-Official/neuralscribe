-- Phase 6 hardening (security advisor):
--   * pin the search_path of the usage immutability trigger function
--   * the secret-gated billing_* write functions are only called by the server's webhook/checkout code, which
--     has no user session (anon role). Signed-in users don't need them at all.
alter function private.usage_immutable() set search_path = '';
revoke execute on function public.billing_event_begin(text, text, text, boolean) from authenticated;
revoke execute on function public.billing_event_finish(text, text, text, text, uuid, text, text) from authenticated;
revoke execute on function public.billing_link_customer(text, uuid, text, boolean) from authenticated;
revoke execute on function public.billing_apply_subscription(text, text, uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean, timestamptz, timestamptz) from authenticated;
