-- Appariement public et atomique des parties en ligne.
-- À appliquer après 202610260003_local_game_mode.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.find_or_create_veylith_match(
    p_user_id uuid,
    p_game_state jsonb
)
RETURNS TABLE(game_id uuid, lifecycle_status text, player_color text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    candidate_game_id uuid;
    queued_game_id uuid;
BEGIN
    -- Repeated polling by the same user reuses their one open queue entry.
    SELECT g.id
      INTO queued_game_id
      FROM public.games AS g
     WHERE g.mode = 'online'
       AND g.visibility = 'public'
       AND g.status = 'waiting'
       AND g.created_by = p_user_id
       AND EXISTS (
            SELECT 1 FROM public.game_players AS own_player
             WHERE own_player.game_id = g.id
               AND own_player.user_id = p_user_id
               AND own_player.color = 'white'
       )
     ORDER BY g.created_at DESC
     LIMIT 1
     FOR UPDATE OF g SKIP LOCKED;

    IF queued_game_id IS NOT NULL THEN
        RETURN QUERY SELECT queued_game_id, 'waiting'::text, 'white'::text;
        RETURN;
    END IF;

    -- Lock one eligible queue entry so two joiners cannot take the same seat.
    SELECT g.id
      INTO candidate_game_id
      FROM public.games AS g
     WHERE g.mode = 'online'
       AND g.visibility = 'public'
       AND g.status = 'waiting'
       AND g.created_by <> p_user_id
       AND NOT EXISTS (
            SELECT 1 FROM public.game_players AS own_player
             WHERE own_player.game_id = g.id
               AND own_player.user_id = p_user_id
       )
       AND NOT EXISTS (
            SELECT 1 FROM public.game_players AS black_player
             WHERE black_player.game_id = g.id
               AND black_player.color = 'black'
       )
       AND NOT EXISTS (
            SELECT 1 FROM public.game_invitations AS invitation
             WHERE invitation.game_id = g.id
               AND invitation.status = 'pending'
       )
     ORDER BY g.created_at
     LIMIT 1
     FOR UPDATE OF g SKIP LOCKED;

    IF candidate_game_id IS NOT NULL THEN
        UPDATE public.games
           SET status = 'ongoing', started_at = now(), updated_at = now()
         WHERE id = candidate_game_id;

        INSERT INTO public.game_players (game_id, user_id, color, role)
        VALUES (candidate_game_id, p_user_id, 'black', 'player');

        RETURN QUERY
        SELECT candidate_game_id, 'ongoing'::text, 'black'::text;
        RETURN;
    END IF;

    INSERT INTO public.games (
        created_by, mode, visibility, status, current_player,
        turn_count, game_state
    )
    VALUES (
        p_user_id, 'online', 'public', 'waiting', 'white',
        0, p_game_state
    )
    RETURNING id INTO queued_game_id;

    INSERT INTO public.game_players (game_id, user_id, color, role)
    VALUES (queued_game_id, p_user_id, 'white', 'player');

    RETURN QUERY SELECT queued_game_id, 'waiting'::text, 'white'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.find_or_create_veylith_match(uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_or_create_veylith_match(uuid, jsonb)
    TO service_role;

COMMIT;
