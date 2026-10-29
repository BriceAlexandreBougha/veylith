# Backend VEYLITH

API HTTP FastAPI, moteur de règles Python et couche de persistance Supabase du jeu VEYLITH.

## Rôle et sécurité

- `src/veylith/domain/` : plateau, terrain, pièces, déplacements, combat, score et victoire, indépendants de l’interface.
- `src/veylith/api/` : routes HTTP, validation des requêtes et sérialisation des états/actions.
- `src/veylith/auth/` : configuration Supabase et validation du jeton d’accès transmis par le client.
- `src/veylith/persistence/` : accès aux profils, parties, actions et fonctions sociales.
- `supabase/migration/` : schéma SQL, permissions et évolutions de la base.
- `tests/` : tests unitaires du moteur, intégration des règles et tests API/sécurité.

Le backend authentifie chaque route privée en vérifiant le jeton auprès de Supabase. La clé `SUPABASE_SERVICE_ROLE_KEY` lui permet d’effectuer des opérations serveur sur les tables ; elle contourne les règles RLS et ne doit donc jamais être copiée dans le frontend, un build `VITE_*`, une réponse API ou un dépôt Git. Le frontend utilise sa clé publique et transmet le jeton en `Authorization: Bearer <access_token>`.

## Prérequis et variables

- Python 3.14 (la contrainte du projet est `>=3.14,<3.15`).
- Un projet Supabase avec Auth et le schéma VEYLITH configurés.
- `backend/.env`, créé depuis `.env.example` :

```dotenv
SUPABASE_URL=https://<projet>.supabase.co
SUPABASE_ANON_KEY=<cle-publique-anon-ou-publishable>
SUPABASE_SERVICE_ROLE_KEY=<cle-secrete-service-role>
```

Ne partage pas le contenu du vrai fichier `.env`. Les paramètres sont lus par Pydantic Settings ; en conteneur Compose, ils sont également transmis via `env_file`.

## Installation et lancement local

Depuis `backend/` sous PowerShell :

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
uvicorn veylith.api.app:app --reload
```

L’API est disponible sur `http://127.0.0.1:8000`. Documentation interactive : `/docs`; schéma OpenAPI : `/openapi.json`; contrôle de santé : `/api/health`.

## Routes disponibles

Les routes de jeu, profil, amis et invitations ci-dessous sont protégées par un jeton Supabase valide. La route de santé est publique.

| Méthode et route | Description |
| --- | --- |
| `GET /api/health` | Disponibilité HTTP de l’API |
| `GET /api/auth/me` | Identité correspondant au jeton Supabase |
| `GET /api/users/me`, `PATCH /api/users/me` | Lire/modifier le profil et le nom d’utilisateur |
| `GET /api/users/search?q=…` | Rechercher des profils |
| `GET /api/friends`, `GET /api/friends/requests` | Relations acceptées et demandes en attente |
| `POST /api/friends/requests` | Envoyer une demande d’ami |
| `POST /api/friends/requests/{id}/accept`, `/reject` | Répondre à une demande |
| `POST /api/games` | Créer une partie |
| `POST /api/games/matchmaking` | Rejoindre/créer une partie de matchmaking |
| `GET /api/games` | Résumés des parties du joueur |
| `GET /api/games/{id}` | État d’une partie accessible |
| `GET /api/games/{id}/actions` | Actions nécessaires à la relecture |
| `GET /api/games/{id}/legal-moves/{piece_id}` | Destinations calculées pour une pièce |
| `POST /api/games/{id}/moves`, `/attacks`, `/exit` | Déplacer, attaquer ou faire sortir une pièce |
| `POST /api/games/{id}/end-turn`, `/abandon` | Terminer le tour ou abandonner |
| `GET /api/games/invitations` | Invitations reçues en attente |
| `POST /api/games/{id}/invitations`, `/api/games/invitations/{id}/accept`, `/reject` | Inviter et répondre à une invitation |
| `DELETE /api/games/{id}/waiting` | Annuler une recherche en attente |
| `PUT /api/games/{id}/presence`, `GET /api/games/{id}/connection` | Présence et état de reconnexion |
| `GET /api/games/{id}/draw-offer`, `POST /api/games/{id}/draw-offers`, `POST /api/games/{id}/draw-offers/{offer_id}/respond` | Propositions d’égalité |
| `PUT /api/games/{id}/rematch-presence`, `GET /api/games/{id}/rematch-status`, `POST /api/games/{id}/rematches` | Disponibilité et invitations de revanche |

Consulte `/docs` pour les schémas exacts des requêtes et réponses, car ceux-ci évoluent avec l’API.

## Schéma de données

Les migrations créent/évoluent notamment `profiles`, `games`, `game_players`, `game_actions`, `friends`, ainsi que les tables de propositions d’égalité et d’invitations. `games` garde l’état actuel; `game_actions` conserve l’historique/relecture. Les règles de jeu sont validées par le moteur côté serveur avant la persistance.

Applique les fichiers de `supabase/migration/` au projet Supabase voulu, une seule fois et dans l’ordre chronologique. Attention : `202610260003_game_draw_offers.sql` et `202610260003_local_game_mode.sql` ont actuellement le même numéro de version. Vérifie l’historique distant avant d’utiliser la CLI Supabase sur une base vierge ou de réconcilier des migrations ; ne renomme pas un script déjà appliqué sans contrôler cet historique. Le script `scripts/clear_games.sql` est un outil manuel destructif, pas une migration ni une étape d’installation.

## Tests et qualité

Depuis `backend/` :

```powershell
pytest --cov=veylith --cov-report=term-missing
ruff check .
ruff format --check .
mypy src
```

- `tests/unit/` : moteur et fonctions de persistance/sérialisation isolées.
- `tests/integration/` : déroulement des parties, tours, déplacements, combat, score et victoire.
- `tests/api/` : routes, authentification, erreurs, invitations, présence et sécurité.

Les tests d’API utilisent les fixtures de `tests/api/conftest.py`; ils ne sont pas destinés à supprimer ou modifier les données du projet Supabase réel.

## Docker

L’image est construite par `backend/Dockerfile`. Compose lit `backend/.env`, attend le succès de `/api/health`, puis démarre le frontend. Pour le démarrage complet, les ports et les consignes de déploiement, voir [../DOCKER.md](../DOCKER.md).
