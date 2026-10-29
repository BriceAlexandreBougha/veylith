-- Crée les profils avec le username choisi à l'inscription ou, pour OAuth,
-- avec la partie précédant l'arobase de l'adresse e-mail.
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    base_username text;
    candidate text;
    suffix text;
BEGIN
    base_username := COALESCE(
        NULLIF(new.raw_user_meta_data ->> 'username', ''),
        NULLIF(split_part(COALESCE(new.email, ''), '@', 1), ''),
        'player'
    );
    base_username := left(regexp_replace(base_username, '[^a-zA-Z0-9_-]', '_', 'g'), 24);
    IF char_length(base_username) < 3 THEN
        base_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 12);
    END IF;

    candidate := base_username;
    WHILE EXISTS (
        SELECT 1 FROM public.profiles p WHERE lower(p.username) = lower(candidate)
    ) LOOP
        suffix := '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 5);
        candidate := left(base_username, 24 - char_length(suffix)) || suffix;
    END LOOP;

    INSERT INTO public.profiles (id, username)
    VALUES (new.id, candidate);
    RETURN new;
END;
$$;

COMMIT;
