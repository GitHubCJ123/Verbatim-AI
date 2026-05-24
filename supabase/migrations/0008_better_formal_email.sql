-- Stronger Formal Email prompt: always produce greeting + body + sign-off.
-- Also re-seeds via update of the seed function so new signups get the
-- improved prompt.

update public.modes
   set system_prompt = $$Rewrite this as a complete formal email.

Structure:
1. A greeting line ("Hi <name>," / "Hello <name>," / "Dear <name>," depending on formality). If no recipient name was spoken, use "Hi there,".
2. A blank line.
3. The body in full, professional sentences. Expand fragmented speech into clear prose. Keep paragraphs short.
4. A blank line.
5. A closing line ("Best," / "Thanks," / "Regards,") followed by the sender's name on the next line — use "Jacob" if no name was spoken, otherwise whatever name the speaker referred to themselves as.

Do not invent new facts. Keep the speaker's intent. Output ONLY the email text, no commentary.$$,
       description = 'Full email shape: greeting, body, sign-off. Always.',
       updated_at = now()
 where name = 'Formal Email';

-- Replace the seed function so new signups get the updated prompt too.
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
     'Universal cleanup. Removes fillers, fixes punctuation, preserves tone.',
     'Make minimal changes. Fix obvious mistakes only. Keep the speaker''s word choice.',
     'auto', null, 'paste', true, true, true, 0),

    (uid, 'Formal Email', 'Mail',
     'Full email shape: greeting, body, sign-off. Always.',
     $email$Rewrite this as a complete formal email.

Structure:
1. A greeting line ("Hi <name>," / "Hello <name>," / "Dear <name>," depending on formality). If no recipient name was spoken, use "Hi there,".
2. A blank line.
3. The body in full, professional sentences. Expand fragmented speech into clear prose. Keep paragraphs short.
4. A blank line.
5. A closing line ("Best," / "Thanks," / "Regards,") followed by the sender's name on the next line — use "Jacob" if no name was spoken, otherwise whatever name the speaker referred to themselves as.

Do not invent new facts. Keep the speaker's intent. Output ONLY the email text, no commentary.$email$,
     'auto', null, 'paste', true, true, true, 1),

    (uid, 'Slack Message', 'MessageSquare',
     'Casual, contractions ok, light emoji if appropriate.',
     'Keep it casual and concise. Contractions are good. No greetings or sign-offs. A single relevant emoji is okay if it fits naturally.',
     'auto', null, 'paste', true, true, true, 2),

    (uid, 'Code Comment', 'Code',
     'Concise, imperative mood, no fluff, wraps around 80 chars.',
     'Write as a short code comment. Use imperative mood. No filler words. Wrap lines around 80 characters.',
     'auto', null, 'paste', true, true, true, 3),

    (uid, 'Notes', 'NotebookPen',
     'Brain-dump friendly. Bullets where they help.',
     'Format as notes. Use short bullets when the speaker is listing things, otherwise short paragraphs. Trim filler words. Keep informal tone.',
     'auto', null, 'review', true, true, true, 4),

    (uid, 'Translate → English', 'Languages',
     'Translates anything into natural English.',
     'Translate the input into natural, fluent English. Preserve meaning. If already English, just polish it.',
     'auto', 'English', 'paste', true, true, true, 5);
end;
$$;
