create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('customer', 'staff'))
);

create table slots (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null unique,
  created_by uuid not null references auth.users(id)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  customer_id uuid not null references auth.users(id),
  pet_name text not null check (char_length(pet_name) between 1 and 60),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_at timestamptz not null default now()
);
create unique index one_active_booking_per_slot on bookings (slot_id) where status = 'booked';

alter table profiles enable row level security;
alter table slots enable row level security;
alter table bookings enable row level security;
create policy "slots are public" on slots for select using (true);
create policy "own bookings" on bookings for select using (customer_id = auth.uid());
create policy "own profile" on profiles for select using (user_id = auth.uid());
