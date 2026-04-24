-- Allow 'monthly_summary' as a valid job_type in dht_email_jobs.
-- Run this in the Supabase SQL editor.

alter table public.dht_email_jobs
  drop constraint if exists dht_email_jobs_job_type_check;

alter table public.dht_email_jobs
  add constraint dht_email_jobs_job_type_check
  check (job_type in ('weekly_summary', 'monthly_summary'));
