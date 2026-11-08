begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cloud-data-backup-every-15-minutes';

select cron.schedule(
  'cloud-data-backup-every-15-minutes',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'cloud_data_backup_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cloud_data_backup_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $job$
);

commit;
