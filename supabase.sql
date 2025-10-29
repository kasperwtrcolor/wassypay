-- Enable UUID + extensions
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- Profiles
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  handle text unique not null,         -- x handle without @
  wallet text,                          -- optional sol address
  profile_image text,
  created_at timestamptz default now()
);

-- Balances (by handle)
create table if not exists balances (
  handle text primary key references profiles(handle) on delete cascade,
  balance_usdc numeric(18,6) not null default 0
);

-- Unified ledger
create table if not exists ledger (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('deposit','send','claim')),
  from_handle text,                     -- null for deposit
  to_handle text,                       -- null for claim
  amount numeric(18,6) not null check (amount > 0),
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Simple helper views
create or replace view payments_by_handle as
select *
from ledger
where (from_handle is not null or to_handle is not null);
