-- Запусти этот SQL в Supabase Dashboard → SQL Editor

-- Таблица хранит все данные пользователя одной строкой на ключ
create table if not exists vital_store (
  id          uuid default gen_random_uuid() primary key,
  user_id     text not null,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz default now(),
  unique (user_id, key)
);

-- Индекс для быстрого поиска по user_id
create index if not exists vital_store_user_idx on vital_store(user_id);

-- RLS: каждый пользователь видит только свои данные
alter table vital_store enable row level security;

create policy "Users can manage own data" on vital_store
  for all
  using (true)
  with check (true);
