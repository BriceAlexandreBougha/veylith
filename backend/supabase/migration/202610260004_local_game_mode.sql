-- Ajoute la création et l'autorisation des parties locales via le même moteur.
-- À appliquer après 202610260002_game_persistence.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_veylith_game_v2(
    p_owner_id uuid,
    p_game_state jsonb,
    p_mode text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    new_game_id uuid;
    initial_status text;
BEGIN
    IF p_mode NOT IN ('online', 'local') THEN
        RAISE EXCEPTION 'Mode de partie invalide.' USING ERRCODE = '22023';
    END IF;

    initial_status := CASE WHEN p_mode = 'local' THEN 'ongoing' ELSE 'waiting' END;

    INSERT INTO public.games (
        created_by,
        mode,
        visibility,
        status,
        current_player,
        turn_count,
        game_state,
        started_at
    )
    VALUES (
        p_owner_id,
        p_mode,
        'private',
        initial_status,
        'white',
        0,
        p_game_state,
        CASE WHEN p_mode = 'local' THEN now() ELSE NULL END
    )
    RETURNING id INTO new_game_id;

    INSERT INTO public.game_players (game_id, user_id, color, role)
    VALUES (new_game_id, p_owner_id, 'white', 'player');

    RETURN new_game_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_veylith_game_action(
    p_game_id uuid,
    p_actor_id uuid,
    p_action_type text,
    p_payload jsonb,
    p_state_after jsonb,
    p_current_player text,
    p_turn_count integer,
    p_status text,
    p_expected_version bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    current_version bigint;
    active_color text;
    game_mode text;
    game_owner uuid;
    next_action_number bigint;
BEGIN
    SELECT version, current_player, mode, created_by
      INTO current_version, active_color, game_mode, game_owner
      FROM public.games
     WHERE id = p_game_id
       AND status = 'ongoing'
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Partie introuvable ou terminée.' USING ERRCODE = 'P0002';
    END IF;

    IF current_version <> p_expected_version THEN
        RAISE EXCEPTION 'La partie a changé; rechargez son état.' USING ERRCODE = '40001';
    END IF;

    IF game_mode = 'local' THEN
        IF p_actor_id <> game_owner THEN
            RAISE EXCEPTION 'Utilisateur non propriétaire.' USING ERRCODE = '42501';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1
          FROM public.game_players gp
         WHERE gp.game_id = p_game_id
           AND gp.user_id = p_actor_id
           AND gp.role = 'player'
           AND gp.color = active_color
    ) THEN
        RAISE EXCEPTION 'Utilisateur hors tour.' USING ERRCODE = '42501';
    END IF;

    next_action_number := current_version + 1;
    INSERT INTO public.game_actions (
        game_id, action_number, actor_id, action_type, payload, state_after
    ) VALUES (
        p_game_id, next_action_number, p_actor_id, p_action_type,
        p_payload, p_state_after
    );

    UPDATE public.games
       SET game_state = p_state_after,
           current_player = p_current_player,
           turn_count = p_turn_count,
           status = p_status,
           version = next_action_number,
           started_at = COALESCE(started_at, now()),
           finished_at = CASE WHEN p_status = 'finished' THEN now() ELSE NULL END,
           updated_at = now()
     WHERE id = p_game_id;

    RETURN next_action_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_veylith_game_invitation(
    p_game_id uuid,
    p_inviter_id uuid,
    p_invitee_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    current_status text;
    game_owner uuid;
    game_mode text;
    created_invitation public.game_invitations;
BEGIN
    IF p_inviter_id = p_invitee_id THEN
        RAISE EXCEPTION 'Invitation invalide.' USING ERRCODE = '22023';
    END IF;

    SELECT status, created_by, mode
      INTO current_status, game_owner, game_mode
      FROM public.games
     WHERE id = p_game_id
     FOR UPDATE;

    IF NOT FOUND
       OR current_status IS DISTINCT FROM 'waiting'
       OR game_owner <> p_inviter_id
       OR game_mode <> 'online' THEN
        RAISE EXCEPTION 'Partie indisponible pour invitation.' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.friends
         WHERE status = 'accepted'
           AND ((requester_id = p_inviter_id AND addressee_id = p_invitee_id)
             OR (requester_id = p_invitee_id AND addressee_id = p_inviter_id))
    ) THEN
        RAISE EXCEPTION 'Les joueurs doivent être amis.' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.game_invitations (
        game_id, inviter_id, invitee_id, color, status
    ) VALUES (p_game_id, p_inviter_id, p_invitee_id, 'black', 'pending')
    RETURNING * INTO created_invitation;

    RETURN to_jsonb(created_invitation);
END;
$$;

REVOKE ALL ON FUNCTION public.create_veylith_game_v2(uuid, jsonb, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_veylith_game_v2(uuid, jsonb, text)
    TO service_role;

REVOKE ALL ON FUNCTION public.record_veylith_game_action(
    uuid, uuid, text, jsonb, jsonb, text, integer, text, bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_veylith_game_action(
    uuid, uuid, text, jsonb, jsonb, text, integer, text, bigint
) TO service_role;

REVOKE ALL ON FUNCTION public.create_veylith_game_invitation(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_veylith_game_invitation(uuid, uuid, uuid)
    TO service_role;

COMMIT;
