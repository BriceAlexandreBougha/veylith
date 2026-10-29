# Lancer VEYLITH avec Docker Compose

Compose démarre deux services : l’API FastAPI et le frontend statique servi par Nginx. Les données et l’authentification restent hébergées dans Supabase ; aucun conteneur PostgreSQL local n’est créé.

## Prérequis

- Docker Desktop installé et démarré, avec le moteur Linux disponible sous Windows.
- Un projet Supabase configuré et les migrations nécessaires appliquées.
- Les fichiers d’environnement préparés ci-dessous.

Si la commande `docker` n’est pas reconnue, Docker Desktop/CLI n’est pas installé ou pas dans le PATH. Si Docker Desktop signale que `Virtual Machine Platform` ou WSL est désactivé, active ces composants Windows avec les droits administrateur puis redémarre. La commande Compose ne peut pas démarrer tant que le moteur Docker est arrêté.

## Configuration

Depuis la racine du dépôt :

```powershell
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
```

Dans le `.env` racine, configure :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (clé `anon` ou `publishable`, publique)
- `FRONTEND_PORT` et `BACKEND_PORT` si les ports par défaut sont déjà utilisés

Dans `backend/.env`, configure :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret serveur)

La clé `service_role` doit rester dans `backend/.env` ou dans le gestionnaire de secrets de l’hébergeur. Elle ne doit jamais être ajoutée au `.env` racine, à `frontend/.env`, à une variable `VITE_*`, ni aux arguments de build frontend. Les fichiers `.env` réels sont exclus de Git.

Compose fixe `VITE_API_URL=/` pour le build : les requêtes navigateur `/api` arrivent sur Nginx puis sont transmises au service `backend` sur le réseau interne.

## Construire et lancer

```powershell
docker compose up --build
```

Par défaut :

| Service | Adresse locale |
| --- | --- |
| Frontend | `http://localhost:8080` |
| API | `http://localhost:8000` |
| Santé API | `http://localhost:8000/api/health` |
| OpenAPI | `http://localhost:8000/docs` |

Les ports publiés sont limités à `127.0.0.1` par défaut. Compose attend que le contrôle de santé backend réponde avant de démarrer le frontend. Pour exécuter en arrière-plan, ajoute `-d`; pour lire les journaux :

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f backend frontend
```

Arrêter les services :

```powershell
docker compose down
```

Cela ne supprime pas les données hébergées dans Supabase. Ne passe pas `-v` sans avoir établi qu’aucun volume de données utile n’est associé.

## URLs Supabase Auth et OAuth

Pour l’interface Docker locale, configure `http://localhost:8080` comme URL de site et autorise la redirection locale correspondante dans Supabase Auth. Pour Vite en développement, l’URL d’interface est `http://localhost:5173`. Configure également les URL de production une fois le domaine définitif connu. Les URL de callback des fournisseurs Google/Apple sont celles fournies par Supabase et doivent être renseignées dans leurs consoles respectives.

Les variables `VITE_*` sont figées dans le bundle lors du build. Après leur modification :

```powershell
docker compose build frontend
docker compose up -d frontend
```

## Publication sur un serveur

Le Compose fourni est prévu pour le développement local : les ports sont liés à localhost et l’API est aussi publiée sur le loopback de l’hôte. Avant exposition publique, prépare un déploiement adapté à l’hébergeur : HTTPS avec un reverse proxy ou un ingress, secrets backend fournis via son gestionnaire de secrets, domaines/redirects OAuth configurés, sauvegardes Supabase et politiques/RLS vérifiées. Ne publie pas directement l’API ou le port Docker sur Internet sans avoir défini les règles réseau et HTTPS du serveur.

Avant d’utiliser la CLI Supabase pour initialiser ou déployer des migrations, consulte [backend/README.md](backend/README.md) : deux migrations portent actuellement le même préfixe de version `202610260003`. Vérifie leur historique distant et les instructions de migration de Supabase avant toute réconciliation; n’utilise pas de reset sur une base de production.

## Dépannage

- **`docker` non reconnu** : installe Docker Desktop et ouvre un nouveau terminal.
- **Pipe `dockerDesktopLinuxEngine` introuvable** : Docker Desktop n’est pas démarré ou son moteur Linux ne tourne pas.
- **WSL / Virtual Machine Platform requis** : active les composants Windows requis avec les droits administrateur, redémarre Windows, puis relance Docker Desktop.
- **Erreur de connexion Supabase au démarrage** : vérifie les trois variables `backend/.env` sans afficher ni partager la clé service.
- **Build frontend ou variables Supabase invalides** : vérifie les deux variables publiques du `.env` racine et reconstruis l’image frontend.
- **Port déjà utilisé** : change `FRONTEND_PORT` ou `BACKEND_PORT` dans le `.env` racine puis relance Compose.
- **401 dans l’application** : reconnecte-toi et vérifie les URL de site et de redirection dans Supabase Auth.
