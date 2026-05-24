-- Verbatim AI — initial schema.
-- Per plan §7. RLS is enabled on every table; policies live in 0002.

-- Profiles mirror auth.users 1:1 so we can add display name etc.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Modes — reusable cleanup presets.
create table public.modes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  icon            text,
  description     text,
  system_prompt   text not null,
  language        text not null default 'auto',
  target_language text,
  output_style    text not null check (output_style in ('paste','review')),
  hotkey          text,
  push_to_talk    boolean not null default true,
  save_history    boolean not null default true,
  is_builtin      boolean not null default false,
  position        int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- App → Mode mappings.
create table public.app_mappings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  app_executable      text not null,
  app_display_name    text not null,
  app_icon_path       text,
  mode_id             uuid references public.modes(id) on delete set null,
  match_window_title  text,
  created_at          timestamptz not null default now()
);

-- Custom vocabulary terms.
create table public.vocabulary (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  term          text not null,
  pronunciation text,
  notes         text,
  created_at    timestamptz not null default now()
);

-- Transcription history.
create table public.transcriptions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  mode_id           uuid references public.modes(id) on delete set null,
  mode_name_snap    text,                              -- denormalized
  raw_text          text,
  cleaned_text      text,
  audio_duration_ms int,
  word_count        int,
  app_executable    text,
  app_window_title  text,
  output_action     text check (output_action in ('pasted','reviewed','copied','discarded')),
  language_detected text,
  cost_cents        int,
  created_at        timestamptz not null default now()
);

-- Per-user app settings.
create table public.user_settings (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  default_mode_id      uuid references public.modes(id) on delete set null,
  global_hotkey        text not null default 'CommandOrControl+Space',
  push_to_talk_default boolean not null default true,
  auto_launch          boolean not null default true,
  theme                text not null default 'dark',
  accent_color         text not null default 'violet',
  overlay_position     text not null default 'bottom-center',
  audio_input_device   text,
  azure_endpoint       text,
  azure_deployment     text,
  show_dock_icon       boolean not null default false,
  send_telemetry       boolean not null default false,
  updated_at           timestamptz not null default now()
);

alter table public.profiles       enable row level security;
alter table public.modes          enable row level security;
alter table public.app_mappings   enable row level security;
alter table public.vocabulary     enable row level security;
alter table public.transcriptions enable row level security;
alter table public.user_settings  enable row level security;
