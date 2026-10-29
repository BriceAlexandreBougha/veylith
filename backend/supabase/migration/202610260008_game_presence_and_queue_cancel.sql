-- Live player presence, disconnect forfeits, queue cleanup, and mutual rematches.
-- Apply after 202610260006_game_rematch_presence.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS public.game_player_presence (
    game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, user_id)
);

ALTER TABLE public.game_player_presence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_player_presence TO service_role;

-- Give both players a short connection grace period as soon as a match starts.
-- The matchmaking RPC changes games.status before inserting the second player,
-- so both transitions need to seed presence independently.
CREATE OR REPLACE FUNCTION public.seed_veylith_game_presence_on_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status = 'ongoing'
       AND OLD.status IS DISTINCT FROM 'ongoing'
       AND NEW.mode = 'online' THEN
        INSERT INTO public.game_player_presence (game_id, user_id, last_seen_at)
        SELECT NEW.id, gp.user_id, now()
          FROM public.game_players AS gp
         WHERE gp.game_id = NEW.id
        ON CONFLICT (game_id, user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_veylith_game_presence_on_player_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.games
         WHERE id = NEW.game_id AND status = 'ongoing' AND mode = 'online'
    ) THEN
        INSERT INTO public.game_player_presence (game_id, user_id, last_seen_at)
        VALUES (NEW.game_id, NEW.user_id, now())
        ON CONFLICT (game_id, user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS veylith_game_presence_on_start ON public.games;
CREATE TRIGGER veylith_game_presence_on_start
    AFTER UPDATE OF status ON public.games
    FOR EACH ROW
    EXECUTE FUNCTION public.seed_veylith_game_presence_on_start();

DROP TRIGGER IF EXISTS veylith_game_presence_on_player_join ON public.game_players;
CREATE TRIGGER veylith_game_presence_on_player_join
    AFTER INSERT ON public.game_players
    FOR EACH ROW
    EXECUTE FUNCTION public.seed_veylith_game_presence_on_player_join();

-- Existing active matches receive a grace window when this migration is applied.
INSERT INTO public.game_player_presence (game_id, user_id, last_seen_at)
SELECT g.id, gp.user_id, now()
  FROM public.games AS g
  JOIN public.game_players AS gp ON gp.game_id = g.id
 WHERE g.mode = 'online' AND g.status = 'ongoing'
ON CONFLICT (game_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.heartbeat_veylith_game_player(
    p_game_id uuid,
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    current_status text;
BEGIN
    SELECT status INTO current_status FROM public.games WHERE id = p_game_id FOR UPDATE;
    IF current_status IS DISTINCT FROM 'ongoing' OR NOT EXISTS (
        SELECT 1 FROM public.game_players
         WHERE game_id = p_game_id AND user_id = p_user_id AND role = 'player'
    ) THEN
        RAISE EXCEPTION 'Partie active ou joueur introuvable.' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.game_player_presence (game_id, user_id, last_seen_at)
    VALUES (p_game_id, p_user_id, now())
    ON CONFLICT (game_id, user_id) DO UPDATE
        SET last_seen_at = EXCLUDED.last_seen_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_veylith_waiting_game(
    p_game_id uuid,
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    participant_count integer;
    creator_id uuid;
    game_status text;
BEGIN
    SELECT created_by, status INTO creator_id, game_status
      FROM public.games WHERE id = p_game_id FOR UPDATE;
    IF creator_id IS NULL OR creator_id <> p_user_id THEN
        RAISE EXCEPTION 'Seul le créateur peut annuler cette partie.' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO participant_count
      FROM public.game_players WHERE game_id = p_game_id;
    IF game_status <> 'waiting' OR participant_count <> 1 THEN
        RAISE EXCEPTION 'La partie a déjà commencé.' USING ERRCODE = '40001';
    END IF;
    DELETE FROM public.games WHERE id = p_game_id;
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
    reverse_invitation public.game_invitations;
    available_player_count integer;
BEGIN
    SELECT status INTO source_status
      FROM public.games WHERE id = p_source_game_id FOR UPDATE;

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

    SELECT count(*) INTO available_player_count
      FROM (
          SELECT user_id, available, updated_at
            FROM public.game_rematch_presence
           WHERE game_id = p_source_game_id
             AND user_id IN (p_inviter_id, p_invitee_id)
           ORDER BY user_id
           FOR UPDATE
      ) AS presence_rows
     WHERE available AND updated_at > now() - interval '15 seconds';
    IF available_player_count <> 2 THEN
        RAISE EXCEPTION 'Un joueur n’est plus disponible pour une revanche.' USING ERRCODE = '40001';
    END IF;

    SELECT * INTO reverse_invitation
      FROM public.game_invitations
     WHERE source_game_id = p_source_game_id
       AND inviter_id = p_invitee_id
       AND invitee_id = p_inviter_id
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF reverse_invitation.id IS NOT NULL THEN
        UPDATE public.games
           SET status = 'ongoing', started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE id = reverse_invitation.game_id AND status = 'waiting';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'La partie de revanche n’est plus disponible.' USING ERRCODE = '40001';
        END IF;

        INSERT INTO public.game_players (game_id, user_id, color, role)
        VALUES (reverse_invitation.game_id, p_inviter_id, 'black', 'player');
        UPDATE public.game_invitations
           SET status = 'accepted', updated_at = now()
         WHERE id = reverse_invitation.id
         RETURNING * INTO created_invitation;
        RETURN to_jsonb(created_invitation);
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

CREATE OR REPLACE FUNCTION public.forfeit_veylith_disconnected_player(
    p_game_id uuid,
    p_user_id uuid,
    p_expected_version bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    game_row public.games;
    last_heartbeat timestamptz;
    next_action_number bigint;
BEGIN
    SELECT * INTO game_row FROM public.games WHERE id = p_game_id FOR UPDATE;
    IF NOT FOUND OR game_row.status <> 'ongoing' THEN
        RAISE EXCEPTION 'La partie n’est plus active.' USING ERRCODE = '40001';
    END IF;
    IF game_row.version <> p_expected_version THEN
        RAISE EXCEPTION 'La partie a changé.' USING ERRCODE = '40001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.game_players
         WHERE game_id = p_game_id AND user_id = p_user_id AND role = 'player'
    ) THEN
        RAISE EXCEPTION 'Joueur introuvable.' USING ERRCODE = '42501';
    END IF;

    SELECT last_seen_at INTO last_heartbeat
      FROM public.game_player_presence
     WHERE game_id = p_game_id AND user_id = p_user_id
     FOR UPDATE;
    last_heartbeat := COALESCE(last_heartbeat, game_row.started_at, game_row.created_at);
    IF last_heartbeat > now() - interval '30 seconds' THEN
        RAISE EXCEPTION 'Le joueur est toujours connecté.' USING ERRCODE = '40001';
    END IF;

    next_action_number := game_row.version + 1;
    INSERT INTO public.game_actions (
        game_id, action_number, actor_id, action_type, payload, state_after
    ) VALUES (
        p_game_id, next_action_number, p_user_id, 'disconnect_forfeit',
        jsonb_build_object('reason', 'heartbeat_timeout', 'timeout_seconds', 30),
        game_row.game_state
    );

    UPDATE public.games
       SET status = 'abandoned', version = next_action_number,
           finished_at = now(), updated_at = now()
     WHERE id = p_game_id;
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_veylith_game_player(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_veylith_waiting_game(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.forfeit_veylith_disconnected_player(uuid, uuid, bigint)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_veylith_game_player(uuid, uuid)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_veylith_waiting_game(uuid, uuid)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.forfeit_veylith_disconnected_player(uuid, uuid, bigint)
    TO service_role;

COMMIT;
