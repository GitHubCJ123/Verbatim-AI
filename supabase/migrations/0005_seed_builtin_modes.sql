-- Seed built-in modes + user_settings whenever a new user signs up.
-- These rows are owned by the user (not read-only). Users can edit,
-- duplicate, reorder, or delete them like any other Mode.

create or replace function public.seed_builtin_modes_for_user(uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.modes
    (user_id, name, icon, description, system_prompt, language, target_language,
     output_style, push_to_talk, save_history, is_builtin, position)
  values
    (uid, 'Default', 'Sparkles',
     'Universal cleanup. Removes fillers, fixes punctuation, preserves tone.',
     'Make minimal changes. Fix obvious mistakes only. Keep the speaker''s word choice.',
     'auto', null, 'paste', true, true, true, 0),

    (uid, 'Formal Email', 'Mail',
     'Proper greeting, full sentences, professional vocabulary.',
     'Write as a professional email. Use complete sentences and a polite tone. Add a brief greeting and sign-off only if appropriate context exists in the speech.',
     'auto', null, 'paste', true, true, true, 1),

    (uid, 'Slack Message', 'MessageSquare',
     'Casual, contractions ok, light emoji if appropriate.',
     'Keep it casual and concise. Contractions are good. No greetings or sign-offs. A single relevant emoji is okay if it fits naturally.',
     'auto', null, 'paste', true, true, true, 2),

    (uid, 'Code Comment', 'Code',
     'Concise, imperative mood, no fluff, wraps around 80 chars.',
     'Write as a short code comment. Use imperative mood. No filler words. Wrap lines around 80 characters.',
     'auto', null, 'paste', true, true, true, 3),

    (uid, 'Notes', 'FileText',
     'Bullet-style, brain-dump friendly.',
     'Format as terse bullet points where appropriate. Preserve the raw thinking style.',
     'auto', null, 'review', true, true, true, 4),

    (uid, 'Translate → English', 'Languages',
     'Translates any input to natural English.',
     'Translate to natural, idiomatic English.',
     'auto', 'English', 'paste', true, true, true, 5);

  insert into public.user_settings (user_id)
  values (uid)
  on conflict (user_id) do nothing;
end;
$$;

-- Replace the trigger function from 0004 so profile creation also seeds.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  perform public.seed_builtin_modes_for_user(new.id);

  return new;
end;
$$;
