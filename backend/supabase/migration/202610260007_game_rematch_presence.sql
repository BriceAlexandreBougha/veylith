-- Synchronise player availability and rematch invitations from a finished game.
BEGIN;

ALTER TABLE public.game_invitations
    ADD COLUMN IF NOT EXISTS source_game_id uuid
        REFERENCES public.games(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS game_invitations_rematch_status
    ON public.game_invitations (source_game_id, inviter_id, created_at DESC)
    WHERE source_game_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS game_invitations_one_pending_rematch
    ON public.game_invitations (source_game_id, invitee_id)
    WHERE source_game_id IS NOT NULL AND status = 'pending';

CREATE TABLE IF NOT EXISTS public.game_rematch_presence (
    game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    available boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, user_id)
);

ALTER TABLE public.game_rematch_presence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_rematch_presence TO service_role;

CREATE OR REPLACE FUNCTION public.set_veylith_game_rematch_presence(
    p_game_id uuid,
    p_user_id uuid,
    p_available boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    game_status text;
BEGIN
    SELECT status INTO game_status
      FROM public.games
     WHERE id = p_game_id;

    IF game_status IS NULL OR game_status NOT IN ('finished', 'abandoned') THEN
        RAISE EXCEPTION 'La partie n’est pas terminée.' USING ERRCODE = '40001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.game_players
         WHERE game_id = p_game_id AND user_id = p_user_id AND role = 'player'
    ) THEN
        RAISE EXCEPTION 'Utilisateur non participant.' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.game_rematch_presence (game_id, user_id, available, updated_at)
    VALUES (p_game_id, p_user_id, p_available, now())
    ON CONFLICT (game_id, user_id) DO UPDATE
        SET available = EXCLUDED.available, updated_at = EXCLUDED.updated_at;

    IF NOT p_available THEN
        UPDATE public.game_invitations
           SET status = 'cancelled', updated_at = now()
         WHERE source_game_id = p_game_id
           AND status = 'pending'
           AND (inviter_id = p_user_id OR invitee_id = p_user_id);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_veylith_rematch_invitation(
    p_source_game_id uuid,
    p_inviter_id uuid,
    p_invitee_id uuid,
    p_game_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    source_status text;
    new_game_id uuid;
    created_invitation public.game_invitations;
BEGIN
    SELECT status INTO source_status
      FROM public.games
     WHERE id = p_source_game_id
     FOR SHARE;

    IF source_status IS NULL OR source_status NOT IN ('finished', 'abandoned') THEN
        RAISE EXCEPTION 'La partie d’origine n’est pas terminée.' USING ERRCODE = '40001';
    END IF;

    IF p_inviter_id = p_invitee_id OR NOT EXISTS (
        SELECT 1 FROM public.game_players
         WHERE game_id = p_source_game_id
           AND user_id IN (p_inviter_id, p_invitee_id)
         GROUP BY game_id
        HAVING count(DISTINCT user_id) = 2
    ) THEN
        RAISE EXCEPTION 'Les deux joueurs doivent avoir participé à la partie.' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.game_rematch_presence
         WHERE game_id = p_source_game_id
           AND user_id = p_inviter_id
           AND available
           AND updated_at > now() - interval '15 seconds'
    ) OR NOT EXISTS (
        SELECT 1 FROM public.game_rematch_presence
         WHERE game_id = p_source_game_id
           AND user_id = p_invitee_id
           AND available
           AND updated_at > now() - interval '15 seconds'
    ) THEN
        RAISE EXCEPTION 'L’adversaire n’est plus disponible pour une revanche.' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.games (
        created_by, mode, visibility, status, current_player, turn_count, game_state
    ) VALUES (
        p_inviter_id, 'online', 'private', 'waiting', 'white', 0, p_game_state
    ) RETURNING id INTO new_game_id;

    INSERT INTO public.game_players (game_id, user_id, color, role)
    VALUES (new_game_id, p_inviter_id, 'white', 'player');

    INSERT INTO public.game_invitations (
        game_id, inviter_id, invitee_id, color, status, source_game_id
    ) VALUES (
        new_game_id, p_inviter_id, p_invitee_id, 'black', 'pending', p_source_game_id
    ) RETURNING * INTO created_invitation;

    RETURN to_jsonb(created_invitation);
END;
$$;

REVOKE ALL ON FUNCTION public.set_veylith_game_rematch_presence(uuid, uuid, boolean)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_veylith_rematch_invitation(uuid, uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_veylith_game_rematch_presence(uuid, uuid, boolean)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.create_veylith_rematch_invitation(uuid, uuid, uuid, jsonb)
    TO service_role;

COMMIT;
