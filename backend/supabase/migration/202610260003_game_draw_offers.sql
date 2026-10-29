-- Propositions d'égalité en ligne, résolues avec l'accord des deux joueurs.
BEGIN;

CREATE TABLE public.game_draw_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id uuid NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    proposer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    responder_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz
);

CREATE UNIQUE INDEX game_draw_offers_one_pending_per_game
    ON public.game_draw_offers (game_id)
    WHERE status = 'pending';

CREATE INDEX game_draw_offers_game_recent
    ON public.game_draw_offers (game_id, created_at DESC);

ALTER TABLE public.game_draw_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_draw_offers TO service_role;

CREATE OR REPLACE FUNCTION public.respond_veylith_draw_offer(
    p_offer_id uuid,
    p_responder_id uuid,
    p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    selected_offer public.game_draw_offers%ROWTYPE;
    selected_game public.games%ROWTYPE;
    next_action_number bigint;
    next_state jsonb;
BEGIN
    SELECT * INTO selected_offer
      FROM public.game_draw_offers
     WHERE id = p_offer_id
     FOR UPDATE;

    IF NOT FOUND OR selected_offer.status <> 'pending' THEN
        RAISE EXCEPTION 'Proposition introuvable ou déjà traitée.' USING ERRCODE = 'P0002';
    END IF;

    IF selected_offer.proposer_id = p_responder_id OR NOT EXISTS (
        SELECT 1
          FROM public.game_players gp
         WHERE gp.game_id = selected_offer.game_id
           AND gp.user_id = p_responder_id
           AND gp.role = 'player'
           AND gp.user_id <> selected_offer.proposer_id
    ) THEN
        RAISE EXCEPTION 'Seul l’adversaire peut répondre.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO selected_game
      FROM public.games
     WHERE id = selected_offer.game_id
     FOR UPDATE;

    IF NOT FOUND OR selected_game.status <> 'ongoing' THEN
        RAISE EXCEPTION 'La partie est déjà terminée.' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.game_draw_offers
       SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,
           responder_id = p_responder_id,
           responded_at = now()
     WHERE id = p_offer_id
    RETURNING * INTO selected_offer;

    IF p_accept THEN
        next_action_number := selected_game.version + 1;
        next_state := jsonb_set(
            jsonb_set(selected_game.game_state, '{status}', '"DRAW"'::jsonb),
            '{winner}', 'null'::jsonb
        );

        INSERT INTO public.game_actions (
            game_id, action_number, actor_id, action_type, payload, state_after
        ) VALUES (
            selected_game.id,
            next_action_number,
            p_responder_id,
            'draw_agreed',
            jsonb_build_object('offer_id', p_offer_id, 'proposer_id', selected_offer.proposer_id),
            next_state
        );

        UPDATE public.games
           SET game_state = next_state,
               status = 'finished',
               version = next_action_number,
               finished_at = now(),
               updated_at = now()
         WHERE id = selected_game.id;
    END IF;

    RETURN jsonb_build_object('offer', to_jsonb(selected_offer), 'accepted', p_accept);
END;
$$;

REVOKE ALL ON FUNCTION public.respond_veylith_draw_offer(uuid, uuid, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_veylith_draw_offer(uuid, uuid, boolean)
    TO service_role;

COMMIT;
