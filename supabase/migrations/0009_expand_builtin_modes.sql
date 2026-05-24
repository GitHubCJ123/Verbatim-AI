-- Expand the built-in Mode library. Adds general-purpose tones (Formal,
-- Casual, Very Casual) plus topical templates (Bullet points, Tweet,
-- LinkedIn post, Meeting note). Existing user rows are backfilled with
-- any built-ins they don't already have (matched by name).

create or replace function public.seed_builtin_modes_for_user(uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_settings (user_id) values (uid)
  on conflict (user_id) do nothing;

  insert into public.modes (
    user_id, name, icon, description, system_prompt,
    language, target_language, output_style,
    push_to_talk, save_history, is_builtin, position
  ) values
    (uid, 'Default', 'Sparkles',
     'Light cleanup. Fixes fillers and punctuation, preserves tone.',
     'Make minimal changes. Remove disfluencies ("um", "uh", false starts). Fix obvious grammar and punctuation. Keep the speaker''s word choice and tone exactly.',
     'auto', null, 'paste', true, true, true, 0),

    (uid, 'Casual', 'MessageCircle',
     'Clear, friendly sentences. No formalities.',
     'Rewrite in clear, conversational sentences. Contractions are good. No greeting or sign-off unless the speaker explicitly said one. Fix grammar and punctuation. Match the speaker''s voice.',
     'auto', null, 'paste', true, true, true, 1),

    (uid, 'Very Casual', 'Smile',
     'Texting energy — lowercase, minimal punctuation.',
     'Texting-style. Lowercase is fine. Minimal punctuation — no periods at end of single sentences. Slang and contractions encouraged. Keep it short and natural. No greeting or sign-off.',
     'auto', null, 'paste', true, true, true, 2),

    (uid, 'Formal', 'GraduationCap',
     'Professional prose. Polished but not email-shaped.',
     'Rewrite as polished, professional prose. Use complete sentences with proper punctuation. Remove all filler words. No contractions. No greeting or sign-off — this is body text only. Preserve the speaker''s argument and intent.',
     'auto', null, 'paste', true, true, true, 3),

    (uid, 'Formal Email', 'Mail',
     'Full email shape: greeting, body, sign-off.',
     $email$Rewrite this as a complete formal email.

Structure:
1. Greeting line ("Hi <name>," / "Hello <name>," / "Dear <name>,"). If no recipient was named, use "Hi there,".
2. Blank line.
3. Body in full, professional sentences. Expand fragmented speech into clear prose. Short paragraphs.
4. Blank line.
5. Closing ("Best," / "Thanks," / "Regards,") then the sender's name on its own line — use whatever name the speaker used for themselves.

Do not invent facts. Keep the speaker's intent. Output ONLY the email text — no commentary, no markdown.$email$,
     'auto', null, 'paste', true, true, true, 4),

    (uid, 'Slack Message', 'MessageSquare',
     'Short, casual, optional emoji.',
     'Keep it short and casual. Contractions are good. No greetings or sign-offs. A single relevant emoji at the start or end is okay if it fits naturally; otherwise skip it.',
     'auto', null, 'paste', true, true, true, 5),

    (uid, 'Code Comment', 'Code',
     'Imperative, concise, ~80 char wrap.',
     'Write as a code comment. Use imperative mood ("Fetch the user", not "This fetches the user"). No filler words. Wrap lines around 80 characters. No leading "//" or "#" — the editor adds those.',
     'auto', null, 'paste', true, true, true, 6),

    (uid, 'Notes', 'NotebookPen',
     'Brain-dump friendly. Bullets where they help.',
     'Format as notes. Use short bullets when the speaker is listing things, otherwise short paragraphs. Trim filler words. Keep informal tone. Use Markdown.',
     'auto', null, 'review', true, true, true, 7),

    (uid, 'Bullet Points', 'List',
     'Convert speech to a clean bulleted list.',
     'Convert the input into a clean bulleted list using Markdown ("- " prefix). One idea per bullet. Sub-bullets (indented) when the speaker clearly nests a thought. Drop filler and connecting words. Sentence fragments are fine if they read clearly.',
     'auto', null, 'paste', true, true, true, 8),

    (uid, 'Tweet / X Post', 'Hash',
     'Punchy, under 280 chars, no hashtag spam.',
     'Rewrite as a single X/Twitter post. Keep it under 280 characters total. Punchy, voice-driven, conversational. One or two hashtags max — only if they add value. No "Thread:" or numbered prefixes. Output the post text only.',
     'auto', null, 'paste', true, true, true, 9),

    (uid, 'LinkedIn Post', 'Linkedin',
     'Professional but warm. Short paragraphs.',
     'Rewrite as a LinkedIn post. Professional but warm. Open with a hook line. Break into short single-sentence paragraphs separated by blank lines. End with a question or call to engagement only if it fits naturally. No hashtags unless the speaker mentioned them.',
     'auto', null, 'paste', true, true, true, 10),

    (uid, 'Meeting Note', 'ClipboardList',
     'Action items + decisions, stripped of filler.',
     'Reformat the transcript into a meeting note. Use these sections only when there is content for them: "## Decisions", "## Action items" (each item starts with "- [ ] @owner: action"), "## Notes". Drop greetings and small talk. Be terse.',
     'auto', null, 'review', true, true, true, 11),

    (uid, 'Translate → English', 'Languages',
     'Translate anything into natural English.',
     'Translate the input into natural, fluent English. Preserve meaning and tone. If the input is already English, just polish it.',
     'auto', 'English', 'paste', true, true, true, 12);
end;
$$;

-- Backfill: insert any of the canonical built-ins that the existing user
-- doesn't already have, matched by name. We re-use the seed function via
-- a helper that filters by NOT EXISTS.
do $$
declare
  u record;
begin
  for u in select id from auth.users loop
    insert into public.modes (
      user_id, name, icon, description, system_prompt,
      language, target_language, output_style,
      push_to_talk, save_history, is_builtin, position
    )
    select
      u.id, src.name, src.icon, src.description, src.system_prompt,
      src.language, src.target_language, src.output_style,
      src.push_to_talk, src.save_history, true, src.position
    from (values
      ('Casual', 'MessageCircle',
       'Clear, friendly sentences. No formalities.',
       'Rewrite in clear, conversational sentences. Contractions are good. No greeting or sign-off unless the speaker explicitly said one. Fix grammar and punctuation. Match the speaker''s voice.',
       'auto', null::text, 'paste', true, true, 1),
      ('Very Casual', 'Smile',
       'Texting energy — lowercase, minimal punctuation.',
       'Texting-style. Lowercase is fine. Minimal punctuation — no periods at end of single sentences. Slang and contractions encouraged. Keep it short and natural. No greeting or sign-off.',
       'auto', null::text, 'paste', true, true, 2),
      ('Formal', 'GraduationCap',
       'Professional prose. Polished but not email-shaped.',
       'Rewrite as polished, professional prose. Use complete sentences with proper punctuation. Remove all filler words. No contractions. No greeting or sign-off — this is body text only. Preserve the speaker''s argument and intent.',
       'auto', null::text, 'paste', true, true, 3),
      ('Bullet Points', 'List',
       'Convert speech to a clean bulleted list.',
       'Convert the input into a clean bulleted list using Markdown ("- " prefix). One idea per bullet. Sub-bullets (indented) when the speaker clearly nests a thought. Drop filler and connecting words. Sentence fragments are fine if they read clearly.',
       'auto', null::text, 'paste', true, true, 8),
      ('Tweet / X Post', 'Hash',
       'Punchy, under 280 chars, no hashtag spam.',
       'Rewrite as a single X/Twitter post. Keep it under 280 characters total. Punchy, voice-driven, conversational. One or two hashtags max — only if they add value. No "Thread:" or numbered prefixes. Output the post text only.',
       'auto', null::text, 'paste', true, true, 9),
      ('LinkedIn Post', 'Linkedin',
       'Professional but warm. Short paragraphs.',
       'Rewrite as a LinkedIn post. Professional but warm. Open with a hook line. Break into short single-sentence paragraphs separated by blank lines. End with a question or call to engagement only if it fits naturally. No hashtags unless the speaker mentioned them.',
       'auto', null::text, 'paste', true, true, 10),
      ('Meeting Note', 'ClipboardList',
       'Action items + decisions, stripped of filler.',
       'Reformat the transcript into a meeting note. Use these sections only when there is content for them: "## Decisions", "## Action items" (each item starts with "- [ ] @owner: action"), "## Notes". Drop greetings and small talk. Be terse.',
       'auto', null::text, 'review', true, true, 11)
    ) as src(
      name, icon, description, system_prompt,
      language, target_language, output_style,
      push_to_talk, save_history, position
    )
    where not exists (
      select 1 from public.modes m
       where m.user_id = u.id and m.name = src.name
    );
  end loop;
end $$;
