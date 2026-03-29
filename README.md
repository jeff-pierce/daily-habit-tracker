# Daily Habit Tracker

This app now supports Supabase magic-link auth, user profiles, admin-only user management, invite emails via Netlify Functions, and per-user weekly summary preferences.

## Environment variables

Copy `.env.example` into your local environment or Netlify site settings and provide real values for:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_APP_URL`
- `ADMIN_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ANTHROPIC_API_KEY`
- `CLAUDE_MODEL` (optional, defaults to `claude-3-5-sonnet-latest`)
- `WEEKLY_SUMMARY_SECRET` (optional, only for manual secure POST runs)

## Supabase setup

1. Run [supabase/sql/auth_admin_setup.sql](supabase/sql/auth_admin_setup.sql) in the Supabase SQL editor.
2. In Supabase Auth settings, set the Site URL and redirect URL to your deployed app URL.
3. Ensure email auth with magic links is enabled.

## Netlify setup

1. Add the environment variables above in Netlify.
2. Deploy the site so the function at `/.netlify/functions/send-invite` is available.
3. Invites are sent through Resend using the configured `RESEND_FROM_EMAIL`.
4. Weekly summaries are sent by the scheduled function at `/.netlify/functions/send-weekly-summary`.

## What changed

- Password login was replaced with email magic links.
- The previous Admin tab is now Settings for all users.
- A new Admin tab is only shown to admin users.
- Admins can invite users, review active days in the last 30 days, inspect current streaks, and promote or demote admin access.
- Users can turn weekly summary emails on or off in Settings.
- Weekly summary send spec: Monday 8:00 AM America/New_York using previous Mon-Sun data and Claude-generated reflection.

## Weekly Summary Pipeline

- Function: `netlify/functions/send-weekly-summary.js`
- Schedule: hourly on Mondays via Netlify schedule, then code-level gate ensures send only at Monday 8:00 AM America/New_York.
- Data window: previous Monday through Sunday (inclusive), representing the prior week as of Sunday night.
- Subject: `Summary of Last Weeks Daily Habits`
- Sections in email body: `Metrics` then `Summary`
- Claude retry policy: 2 retries after initial failure (3 total attempts), then fallback plain summary.
- Privacy: prompt/response text is not persisted; only job metadata/status is stored in `dht_email_jobs`.
