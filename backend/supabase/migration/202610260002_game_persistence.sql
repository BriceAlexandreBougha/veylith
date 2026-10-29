-- Persistance atomique des parties et de leur historique.
-- À appliquer au projet Supabase après revue.

BEGIN;

-- Le backend utilise service_role; RLS ne remplace pas les privilèges SQL.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.profiles,
    public.games,
    public.game_players,
    public.game_actions,
    public.friends
TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.game_actions_id_seq TO service_role;

CREATE TABLE public.game_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    inviter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    invitee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    color text NOT NULL CHECK (color IN ('white', 'black')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (inviter_id <> invitee_id)
);

CREATE UNIQUE INDEX game_invitations_one_pending_invitee
    ON public.game_invitations (game_id, invitee_id)
    WHERE status = 'pending';

CREATE INDEX game_invitations_invitee_pending
    ON public.game_invitations (invitee_id, created_at DESC)
    WHERE status = 'pending';

ALTER TABLE public.game_invitations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_invitations TO service_role;

CREATE OR REPLACE FUNCTION public.create_veylith_game(
    p_owner_id uuid,
    p_game_state jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    new_game_id uuid;
BEGIN
    INSERT INTO public.games (
        created_by,
        mode,
        visibility,
        status,
        current_player,
        turn_count,
        game_state
    )
    VALUES (
        p_owner_id,
        'online',
        'private',
        'waiting',
        'white',
        0,
        p_game_state
    )
    RETURNING id INTO new_game_id;

    INSERT INTO public.game_players (game_id, user_id, color, role)
    VALUES (new_game_id, p_owner_id, 'white', 'player');

    RETURN new_game_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_veylith_friend_request(
    p_requester_id uuid,
    p_addressee_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    created_relation public.friends;
BEGIN
    IF p_requester_id = p_addressee_id THEN
        RAISE EXCEPTION 'Impossible de s’ajouter soi-même.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.friends (requester_id, addressee_id, status)
    VALUES (p_requester_id, p_addressee_id, 'pending')
    RETURNING * INTO created_relation;

    RETURN to_jsonb(created_relation);
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_veylith_friend_request(
    p_request_id uuid,
    p_user_id uuid,
    p_response text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    updated_relation public.friends;
BEGIN
    IF p_response NOT IN ('accepted', 'rejected') THEN
        RAISE EXCEPTION 'Réponse invalide.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.friends
       SET status = p_response, updated_at = now()
     WHERE id = p_request_id
       AND addressee_id = p_user_id
       AND status = 'pending'
    RETURNING * INTO updated_relation;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Demande introuvable.' USING ERRCODE = 'P0002';
    END IF;

    RETURN to_jsonb(updated_relation);
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
    created_invitation public.game_invitations;
BEGIN
    IF p_inviter_id = p_invitee_id THEN
        RAISE EXCEPTION 'Invitation invalide.' USING ERRCODE = '22023';
    END IF;

    SELECT status, created_by
      INTO current_status, game_owner
      FROM public.games
     WHERE id = p_game_id
     FOR UPDATE;

    IF NOT FOUND OR current_status IS DISTINCT FROM 'waiting' OR game_owner <> p_inviter_id THEN
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

CREATE OR REPLACE FUNCTION public.respond_veylith_game_invitation(
    p_invitation_id uuid,
    p_user_id uuid,
    p_response text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    invitation public.game_invitations;
    updated_invitation public.game_invitations;
    current_status text;
BEGIN
    IF p_response NOT IN ('accepted', 'rejected') THEN
        RAISE EXCEPTION 'Réponse invalide.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO invitation
      FROM public.game_invitations
     WHERE id = p_invitation_id
       AND invitee_id = p_user_id
       AND status = 'pending'
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invitation introuvable.' USING ERRCODE = 'P0002';
    END IF;

    IF p_response = 'accepted' THEN
        SELECT status INTO current_status
          FROM public.games
         WHERE id = invitation.game_id
         FOR UPDATE;

        IF current_status IS DISTINCT FROM 'waiting' THEN
            RAISE EXCEPTION 'La partie n’attend plus de joueur.' USING ERRCODE = '40001';
        END IF;

        INSERT INTO public.game_players (game_id, user_id, color, role)
        VALUES (invitation.game_id, p_user_id, invitation.color, 'player');

        UPDATE public.games
           SET status = 'ongoing', started_at = now(), updated_at = now()
         WHERE id = invitation.game_id;
    END IF;

    UPDATE public.game_invitations
       SET status = p_response, updated_at = now()
     WHERE id = p_invitation_id
    RETURNING * INTO updated_invitation;

    RETURN to_jsonb(updated_invitation);
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
    next_action_number bigint;
BEGIN
    SELECT version, current_player
      INTO current_version, active_color
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

    IF NOT EXISTS (
        SELECT 1
          FROM public.game_players gp
         WHERE gp.game_id = p_game_id
           AND gp.user_id = p_actor_id
           AND gp.role = 'player'
           AND gp.color = active_color
    ) THEN
        RAISE EXCEPTION 'Utilisateur non participant.' USING ERRCODE = '42501';
    END IF;

    next_action_number := current_version + 1;

    INSERT INTO public.game_actions (
        game_id,
        action_number,
        actor_id,
        action_type,
        payload,
        state_after
    )
    VALUES (
        p_game_id,
        next_action_number,
        p_actor_id,
        p_action_type,
        p_payload,
        p_state_after
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

CREATE OR REPLACE FUNCTION public.abandon_veylith_game(
    p_game_id uuid,
    p_actor_id uuid,
    p_state_after jsonb,
    p_expected_version bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    current_version bigint;
    current_status text;
    next_action_number bigint;
BEGIN
    SELECT version, status
      INTO current_version, current_status
      FROM public.games
     WHERE id = p_game_id
       AND status IN ('waiting', 'ongoing')
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Partie introuvable ou terminée.' USING ERRCODE = 'P0002';
    END IF;

    IF current_version <> p_expected_version THEN
        RAISE EXCEPTION 'La partie a changé; rechargez son état.' USING ERRCODE = '40001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.game_players
         WHERE game_id = p_game_id
           AND user_id = p_actor_id
           AND role = 'player'
    ) THEN
        RAISE EXCEPTION 'Utilisateur non participant.' USING ERRCODE = '42501';
    END IF;

    next_action_number := current_version + 1;
    INSERT INTO public.game_actions (
        game_id, action_number, actor_id, action_type, payload, state_after
    ) VALUES (
        p_game_id, next_action_number, p_actor_id, 'abandon',
        jsonb_build_object('previous_status', current_status), p_state_after
    );

    UPDATE public.games
       SET game_state = p_state_after,
           status = 'abandoned',
           version = next_action_number,
           finished_at = NULL,
           updated_at = now()
     WHERE id = p_game_id;

    UPDATE public.game_invitations
       SET status = 'cancelled', updated_at = now()
     WHERE game_id = p_game_id
       AND status = 'pending';

    RETURN next_action_number;
END;
$$;

REVOKE ALL ON FUNCTION public.create_veylith_game(uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_veylith_game_action(
    uuid, uuid, text, jsonb, jsonb, text, integer, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_veylith_friend_request(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.respond_veylith_friend_request(uuid, uuid, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_veylith_game_invitation(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.respond_veylith_game_invitation(uuid, uuid, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abandon_veylith_game(uuid, uuid, jsonb, bigint)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_veylith_game(uuid, jsonb)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.send_veylith_friend_request(uuid, uuid)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.respond_veylith_friend_request(uuid, uuid, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.create_veylith_game_invitation(uuid, uuid, uuid)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.respond_veylith_game_invitation(uuid, uuid, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.abandon_veylith_game(uuid, uuid, jsonb, bigint)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.record_veylith_game_action(
    uuid, uuid, text, jsonb, jsonb, text, integer, text, bigint
) TO service_role;

COMMIT;
