# VEYLITH

VEYLITH est un jeu de stratégie en ligne et local sur un plateau 3D de 10 × 10 cases à relief variable. Le dépôt contient le frontend, l’API, le moteur de règles, la persistance Supabase, les migrations SQL et les modèles 3D utilisés pendant les parties.

## Ce que contient le projet

| Dossier / fichier | Rôle |
| --- | --- |
| `frontend/` | Application React + TypeScript + Vite, authentification Supabase, interface et plateau 3D Three.js |
| `backend/` | API FastAPI, moteur de jeu Python, accès Supabase, tests et migrations |
| `compose.yaml` | Lancement local du frontend et de l’API avec Docker Compose |
| `DOCKER.md` | Détails de configuration et de démarrage Docker |
| `backend/scripts/clear_games.sql` | Nettoyage manuel des parties et de leurs données associées ; à réserver aux environnements où cette suppression est voulue |

La documentation dédiée se trouve dans [frontend/README.md](frontend/README.md), [backend/README.md](backend/README.md) et [DOCKER.md](DOCKER.md).

## Architecture

```text
Navigateur
  ├─ React / Vite / Three.js
  ├─ Supabase Auth (session, e-mail et fournisseurs OAuth configurés dans Supabase)
  └─ API FastAPI : /api/* avec le jeton Supabase dans Authorization: Bearer …
       ├─ règles et validation des actions côté serveur
       └─ Supabase Postgres : profils, parties, joueurs, actions, amis et invitations
```

Le navigateur utilise uniquement la clé Supabase publique (`anon` ou `publishable`). Les opérations de persistance de confiance passent par l’API avec `SUPABASE_SERVICE_ROLE_KEY`, qui ne doit jamais être exposée dans le frontend ni dans une variable `VITE_*`. Le moteur Python reste l’autorité pour valider les coups ; le frontend calcule également des indications et rend le plateau, mais ses calculs ne remplacent pas la validation serveur.

## Prérequis

- Un projet Supabase accessible, avec Auth configuré et les migrations SQL appliquées.
- Python 3.14 pour l’exécution locale du backend.
- Node.js 24 recommandé pour le frontend et Docker.
- Docker Desktop démarré pour l’exécution Compose.

## Configuration des variables

Les fichiers `.env.example` ne contiennent que des exemples. Crée les fichiers locaux sans copier de vraie clé dans Git :

```powershell
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

- Racine `.env` : URL Supabase et clé publique pour le build Docker du frontend, ports locaux facultatifs.
- `backend/.env` : `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- `frontend/.env` : `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` pour Vite en local.

Les valeurs `VITE_*` sont incorporées dans les fichiers JavaScript du frontend : elles sont publiques. N’y place jamais la clé `service_role`. Les vrais fichiers `.env` sont ignorés par Git.

## Démarrage local sans Docker

Ouvre deux terminaux depuis la racine du dépôt.

Terminal backend :

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
uvicorn veylith.api.app:app --reload
```

Terminal frontend :

```powershell
Set-Location frontend
npm ci
npm run dev
```

Vite affiche l’adresse de l’interface, normalement `http://localhost:5173`. L’API écoute sur `http://127.0.0.1:8000`, sa documentation est à `/docs` et sa route de santé à `/api/health`.

## Démarrage avec Docker

Après configuration des fichiers `.env` :

```powershell
docker compose up --build
```

L’interface est exposée sur `http://localhost:8080` et l’API sur `http://localhost:8000`. Dans Compose, Nginx relaie `/api/` vers l’API dans le réseau Docker. Les ports publiés sont liés à `127.0.0.1` par défaut. Voir [DOCKER.md](DOCKER.md) pour les ports, OAuth et les précautions de déploiement.

## Fonctionnalités présentes

- Inscription, connexion, confirmation/réinitialisation par e-mail et OAuth pris en charge par Supabase (Google/Apple selon la configuration du projet).
- Profil et nom d’utilisateur, recherche d’utilisateurs, relations d’amitié et invitations.
- Parties locales, matchmaking et invitations de partie.
- Plateau 3D avec relief, pièces FBX et modèles de tuiles GLB sous `frontend/public/models/`.
- Actions de jeu validées côté API, historique et analyse/relecture avec variantes temporaires.
- Présence, reconnexion, propositions de nulle et revanche selon l’état enregistré et les migrations installées.

L’IA/bot n’est pas encore implémentée. Les fournisseurs OAuth, les URL de retour et les permissions de base doivent être configurés dans le projet Supabase utilisé.

## Tests et contrôles

Depuis `backend/` :

```powershell
pytest --cov=veylith --cov-report=term-missing
ruff check .
ruff format --check .
mypy src
```

Depuis `frontend/` :

```powershell
npm test
npm run build
```

Les tests frontend couvrent les déplacements locaux, combats et simulations d’analyse. Le build exécute TypeScript (`tsc -b`) puis Vite. Les tests backend sont répartis entre `tests/unit/`, `tests/integration/` et `tests/api/`.

## Migrations Supabase

Les scripts sont dans `backend/supabase/migration/` et doivent être appliqués une fois, dans l’ordre chronologique, sur le bon projet Supabase. Le dépôt contient actuellement deux fichiers avec le même préfixe de version `202610260003` (`game_draw_offers` et `local_game_mode`). Avant une installation vierge pilotée par la CLI Supabase, vérifie et réconcilie cette version avec l’historique de migrations du projet distant ; ne renomme pas une migration déjà exécutée sans vérifier cet historique. Ne lance pas de reset sur une base de production.

## Nettoyage et changements de données

Le script `backend/scripts/clear_games.sql` supprime les parties et leurs données dépendantes. Il est volontairement conservé comme outil d’administration demandé précédemment, mais son exécution est destructive et ne doit se faire que sur la base ciblée après vérification. Il ne fait pas partie du démarrage normal du jeu.

Les répertoires `node_modules/`, `backend/.venv/`, `frontend/dist/` et les caches sont des artefacts locaux régénérables ou des environnements d’exécution ; ils sont ignorés par Git. Les modèles 3D, migrations, tests et fichiers source font partie du projet et ne doivent pas être supprimés lors du nettoyage.
