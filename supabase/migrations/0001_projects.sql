-- Agent orchestration app: projects, the tasks the engine runs, each attempt, and a raw event log.
-- The engine writes with the service-role key (bypasses RLS). Signed-in users can read their own
-- projects live (Realtime) and do exactly two things: create a project and decide on its plan.

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  description text not null check (char_length(description) between 20 and 20000),
  model       text not null default 'haiku' check (model in ('haiku', 'sonnet')),
  status      text not null default 'queued'
              check (status in ('queued', 'planning', 'awaiting_approval', 'approved', 'rejected',
                                'building', 'done', 'failed')),
  plan        jsonb,
  plan_note   text,
  cost_usd    numeric(10, 4) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.tasks (
  project_id  uuid not null references public.projects on delete cascade,
  id          text not null,
  title       text not null,
  role        text not null check (role in ('planner', 'qa', 'dev')),
  depends_on  text[] not null default '{}',
  status      text not null default 'queued',
  attempt     int not null default 0,
  cost_usd    numeric(10, 4) not null default 0,
  error       text,
  updated_at  timestamptz not null default now(),
  primary key (project_id, id)
);

create table public.attempts (
  project_id    uuid not null references public.projects on delete cascade,
  task_id       text not null,
  n             int not null,
  passed        boolean not null,
  claim         text,
  reason        text,
  cost_usd      numeric(10, 4) not null default 0,
  seconds       numeric(10, 1),
  turns         int,
  files_changed text[] not null default '{}',
  created_at    timestamptz not null default now(),
  primary key (project_id, task_id, n)
);

create table public.events (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects on delete cascade,
  kind        text not null,
  task_id     text,
  data        jsonb not null default '{}',
  ts          timestamptz not null default now()
);
create index events_project_ts on public.events (project_id, ts);

-- Row level security: read your own, nothing else.
alter table public.projects enable row level security;
alter table public.tasks    enable row level security;
alter table public.attempts enable row level security;
alter table public.events   enable row level security;

create policy "own projects: read"   on public.projects for select using (owner = auth.uid());
create policy "own projects: create" on public.projects for insert
  with check (owner = auth.uid() and status = 'queued' and plan is null and cost_usd = 0);
create policy "own tasks: read"    on public.tasks    for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner = auth.uid()));
create policy "own attempts: read" on public.attempts for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner = auth.uid()));
create policy "own events: read"   on public.events   for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner = auth.uid()));

-- The only way a user changes a project: approve or reject a plan that is waiting for them.
create function public.decide_plan(project uuid, approved boolean, note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.projects
     set status = case when approved then 'approved' else 'rejected' end,
         plan_note = left(note, 2000), updated_at = now()
   where id = project and owner = auth.uid() and status = 'awaiting_approval';
  if not found then
    raise exception 'plan is not waiting for your approval';
  end if;
end $$;
revoke all on function public.decide_plan(uuid, boolean, text) from public, anon;
grant execute on function public.decide_plan(uuid, boolean, text) to authenticated;

-- Live updates for the board.
alter publication supabase_realtime add table public.projects, public.tasks, public.attempts, public.events;
