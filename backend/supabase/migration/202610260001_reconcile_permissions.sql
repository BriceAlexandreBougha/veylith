-- Restaure uniquement les privilèges manquants
-- prévus par la migration initiale de Veylith.

GRANT UPDATE (username, avatar_url, updated_at)
    ON TABLE public.profiles
    TO authenticated;

GRANT INSERT (requester_id, addressee_id, status)
    ON TABLE public.friends
    TO authenticated;

GRANT UPDATE (status, updated_at)
    ON TABLE public.friends
    TO authenticated;
