BEGIN;

DELETE FROM public.games;

SELECT
    (SELECT count(*) FROM public.games) AS games_restantes,
    (SELECT count(*) FROM public.game_players) AS joueurs_de_partie_restants,
    (SELECT count(*) FROM public.game_actions) AS actions_restantes,
    (SELECT count(*) FROM public.game_invitations) AS invitations_restantes,
    (SELECT count(*) FROM public.game_draw_offers) AS propositions_egalite_restantes,
    (SELECT count(*) FROM public.game_player_presence) AS presences_restantes,
    (SELECT count(*) FROM public.game_rematch_presence) AS presences_revanche_restantes;

COMMIT;