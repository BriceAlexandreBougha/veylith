
-- ============================================================
-- Veylith : schéma initial
-- Supabase PostgreSQL
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. Profils publics
-- L'identité et les mots de passe restent dans auth.users.
-- ------------------------------------------------------------

CREATE TABLE public.profiles (
    id uuid PRIMARY KEY
        REFERENCES auth.users(id) ON DELETE CASCADE,

    username text NOT NULL,
    avatar_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT profiles_username_length
        CHECK (char_length(username) BETWEEN 3 AND 24),

    CONSTRAINT profiles_username_format
        CHECK (username ~ '^[a-zA-Z0-9_-]+$')
);

CREATE UNIQUE INDEX profiles_username_unique_ci
    ON public.profiles (lower(username));


-- ------------------------------------------------------------
-- 2. Parties
-- game_state contient la sérialisation complète du moteur.
-- ------------------------------------------------------------

CREATE TABLE public.games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    created_by uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,

    mode text NOT NULL DEFAULT 'online',
    visibility text NOT NULL DEFAULT 'private',
    status text NOT NULL DEFAULT 'waiting',

    current_player text,
    turn_count integer NOT NULL DEFAULT 0,
    game_state jsonb NOT NULL DEFAULT '{}'::jsonb,

    version bigint NOT NULL DEFAULT 0,

    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT games_mode_check
        CHECK (mode IN ('local', 'online', 'ai')),

    CONSTRAINT games_visibility_check
        CHECK (visibility IN ('public', 'private')),

    CONSTRAINT games_status_check
        CHECK (status IN ('waiting', 'ongoing', 'finished', 'abandoned')),

    CONSTRAINT games_current_player_check
        CHECK (
            current_player IS NULL
            OR current_player IN ('white', 'black')
        ),

    CONSTRAINT games_turn_count_check
        CHECK (turn_count >= 0),

    CONSTRAINT games_version_check
        CHECK (version >= 0),

    CONSTRAINT games_state_object_check
        CHECK (jsonb_typeof(game_state) = 'object')
);

CREATE INDEX games_public_waiting_idx
    ON public.games (created_at DESC)
    WHERE visibility = 'public' AND status = 'waiting';

CREATE INDEX games_creator_idx
    ON public.games (created_by, created_at DESC);


-- ------------------------------------------------------------
-- 3. Participants
-- Une couleur ne peut être attribuée qu'une fois par partie.
-- ------------------------------------------------------------

CREATE TABLE public.game_players (
    game_id uuid NOT NULL
        REFERENCES public.games(id) ON DELETE CASCADE,

    user_id uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,

    color text NOT NULL,
    role text NOT NULL DEFAULT 'player',
    joined_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (game_id, user_id),

    CONSTRAINT game_players_color_check
        CHECK (color IN ('white', 'black')),

    CONSTRAINT game_players_role_check
        CHECK (role IN ('player', 'spectator')),

    CONSTRAINT game_players_one_player_per_color
        UNIQUE (game_id, color)
);

CREATE INDEX game_players_user_idx
    ON public.game_players (user_id, joined_at DESC);


-- ------------------------------------------------------------
-- 4. Historique des actions
-- Les écritures seront gérées par le backend de confiance.
-- ------------------------------------------------------------

CREATE TABLE public.game_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    game_id uuid NOT NULL
        REFERENCES public.games(id) ON DELETE CASCADE,

    action_number bigint NOT NULL,
    actor_id uuid
        REFERENCES auth.users(id) ON DELETE SET NULL,

    action_type text NOT NULL,
    payload jsonb NOT NULL,
    state_after jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT game_actions_number_positive
        CHECK (action_number > 0),

    CONSTRAINT game_actions_type_length
        CHECK (char_length(action_type) BETWEEN 1 AND 50),

    CONSTRAINT game_actions_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),

    CONSTRAINT game_actions_state_object
        CHECK (
            state_after IS NULL
            OR jsonb_typeof(state_after) = 'object'
        ),

    CONSTRAINT game_actions_unique_number
        UNIQUE (game_id, action_number)
);

CREATE INDEX game_actions_history_idx
    ON public.game_actions (game_id, action_number);


-- ------------------------------------------------------------
-- 5. Amis : demandes et relations acceptées
-- ------------------------------------------------------------

CREATE TABLE public.friends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    requester_id uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE CASCADE,

    addressee_id uuid NOT NULL
        REFERENCES auth.users(id) ON DELETE CASCADE,

    status text NOT NULL DEFAULT 'pending',

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT friends_no_self_friends
        CHECK (requester_id <> addressee_id),

    CONSTRAINT friends_status_check
        CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked'))
);

-- Une seule relation par paire, quel que soit le sens.
CREATE UNIQUE INDEX friends_unique_pair_idx
    ON public.friends (
        LEAST(requester_id, addressee_id),
        GREATEST(requester_id, addressee_id)
    );

CREATE INDEX friends_pending_received_idx
    ON public.friends (addressee_id, created_at DESC)
    WHERE status = 'pending';

CREATE INDEX friends_accepted_requester_idx
    ON public.friends (requester_id)
    WHERE status = 'accepted';

CREATE INDEX friends_accepted_addressee_idx
    ON public.friends (addressee_id)
    WHERE status = 'accepted';


-- ------------------------------------------------------------
-- 6. Création automatique d'un profil à l'inscription
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    initial_username text;
BEGIN
    initial_username :=
        'player_' || substr(replace(new.id::text, '-', ''), 1, 16);

    INSERT INTO public.profiles (id, username)
    VALUES (new.id, initial_username);

    RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();


-- ------------------------------------------------------------
-- 7. Activation de RLS
-- ------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 8. Politiques des profils
-- ------------------------------------------------------------

CREATE POLICY "Profiles are readable"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users update their own profile"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING ((SELECT auth.uid()) = id)
    WITH CHECK ((SELECT auth.uid()) = id);


-- ------------------------------------------------------------
-- 9. Politiques des parties
-- ------------------------------------------------------------

CREATE POLICY "Read public games or own games"
    ON public.games
    FOR SELECT
    TO authenticated
    USING (
        visibility = 'public'
        OR created_by = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1
            FROM public.game_players gp
            WHERE gp.game_id = games.id
              AND gp.user_id = (SELECT auth.uid())
        )
    );


-- ------------------------------------------------------------
-- 10. Politiques des participants
-- ------------------------------------------------------------

CREATE POLICY "Read participants of accessible games"
    ON public.game_players
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.games g
            WHERE g.id = game_players.game_id
              AND (
                  g.visibility = 'public'
                  OR g.created_by = (SELECT auth.uid())
                  OR EXISTS (
                      SELECT 1
                      FROM public.game_players own
                      WHERE own.game_id = g.id
                        AND own.user_id = (SELECT auth.uid())
                  )
              )
        )
    );


-- ------------------------------------------------------------
-- 11. Politiques de l'historique
-- ------------------------------------------------------------

CREATE POLICY "Read history of own games"
    ON public.game_actions
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.games g
            WHERE g.id = game_actions.game_id
              AND (
                  g.created_by = (SELECT auth.uid())
                  OR EXISTS (
                      SELECT 1
                      FROM public.game_players gp
                      WHERE gp.game_id = g.id
                        AND gp.user_id = (SELECT auth.uid())
                  )
              )
        )
    );


-- ------------------------------------------------------------
-- 12. Politiques des amis
-- ------------------------------------------------------------

CREATE POLICY "Users read their own friends"
    ON public.friends
    FOR SELECT
    TO authenticated
    USING (
        requester_id = (SELECT auth.uid())
        OR addressee_id = (SELECT auth.uid())
    );

CREATE POLICY "Users send friend requests"
    ON public.friends
    FOR INSERT
    TO authenticated
    WITH CHECK (
        requester_id = (SELECT auth.uid())
        AND status = 'pending'
        AND requester_id <> addressee_id
    );

-- Le destinataire peut répondre à une demande en attente.
-- Il ne peut pas modifier les identifiants des deux utilisateurs.
CREATE POLICY "Recipients respond to friend requests"
    ON public.friends
    FOR UPDATE
    TO authenticated
    USING (
        addressee_id = (SELECT auth.uid())
        AND status = 'pending'
    )
    WITH CHECK (
        addressee_id = (SELECT auth.uid())
        AND status IN ('accepted', 'rejected')
        AND requester_id <> addressee_id
    );

CREATE POLICY "Users remove friends"
    ON public.friends
    FOR DELETE
    TO authenticated
    USING (
        requester_id = (SELECT auth.uid())
        OR addressee_id = (SELECT auth.uid())
    );


-- ------------------------------------------------------------
-- 13. Permissions sur les tables
-- Les écritures de jeu sont réservées au backend de confiance.
-- ------------------------------------------------------------

REVOKE ALL ON TABLE
    public.profiles,
    public.games,
    public.game_players,
    public.game_actions,
    public.friends
FROM anon, authenticated;

GRANT SELECT ON TABLE
    public.profiles,
    public.games,
    public.game_players,
    public.game_actions,
    public.friends
TO authenticated;

GRANT UPDATE (username, avatar_url, updated_at)
    ON public.profiles TO authenticated;

GRANT INSERT (requester_id, addressee_id, status)
    ON public.friends TO authenticated;

GRANT UPDATE (status, updated_at)
    ON public.friends TO authenticated;

GRANT DELETE ON TABLE public.friends TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.game_actions_id_seq
    TO service_role;

COMMIT;