# Frontend VEYLITH

Application navigateur de VEYLITH construite avec React 19, TypeScript, Vite et Three.js. Elle gère l’authentification Supabase, les écrans du jeu, le plateau 3D, le tutoriel, les amis, l’historique et l’analyse/relecture des parties.

## Prérequis

- Node.js 24 recommandé (même version majeure que l’image Docker de build).
- Un projet Supabase configuré pour Auth.
- L’API FastAPI démarrée pour les fonctions de partie, profil et social.

## Configuration locale

Dans `frontend/`, copie `.env.example` en `.env` et renseigne :

```dotenv
VITE_SUPABASE_URL=https://<projet>.supabase.co
VITE_SUPABASE_ANON_KEY=<cle-publique-anon-ou-publishable>
VITE_API_URL=http://127.0.0.1:8000
```

Ces valeurs sont publiques dans un build navigateur. Ne configure jamais `SUPABASE_SERVICE_ROLE_KEY` ici. La clé service est exclusivement destinée au backend.

Puis démarre le serveur :

```powershell
npm ci
npm run dev
```

Vite sert normalement l’application sur `http://localhost:5173`. Vérifie que le backend est accessible sur l’adresse de `VITE_API_URL`. Le backend autorise actuellement les origines Vite `localhost:5173` et `127.0.0.1:5173`.

## Construire et prévisualiser

```powershell
npm run build
npm run preview
```

Le build lance d’abord la vérification TypeScript puis produit `dist/`. Vite est configuré pour l’application monopage. En Docker, Nginx sert le build, compresse les réponses, garde les assets versionnés en cache et transmet `/api/` au backend.

Les variables `VITE_*` sont injectées au moment du build. Après leur changement dans Docker, reconstruis l’image frontend :

```powershell
docker compose build frontend
docker compose up -d frontend
```

## Organisation du code

- `src/App.tsx` : initialise la session Supabase et choisit l’écran d’authentification ou l’application connectée.
- `src/components/Dashboard.tsx` : navigation et écrans de profil, recherche, amis, historique, lobby et partie.
- `src/components/GameBoard3D.tsx` : scène Three.js, terrain modulaire, pièces, interactions, caméra et animation des actions.
- `src/components/GameAnalysis.tsx` : relecture de partie et branches d’analyse temporaires.
- `src/lib/api.ts` : client HTTP, ajout du jeton Supabase, renouvellement après 401 et types partagés avec l’API.
- `src/lib/supabase.ts` : client public Supabase Auth.
- `src/lib/movement.ts`, `combat.ts`, `analysisEngine.ts` : calculs utilisés pour les indications et l’analyse dans le navigateur.
- `src/veylith.css` : styles de l’application.
- `public/models/pieces/` : modèles FBX des pièces ivoire et obsidienne et leurs ressources associées.
- `public/models/tiles/` : cinq variantes GLB des tuiles de pierre.

Le navigateur transmet le jeton d’accès Supabase à l’API avec `Authorization: Bearer <access_token>`. En développement local, l’API utilise CORS. En Docker, les appels `/api` passent par Nginx et utilisent le réseau interne.

## Authentification et redirections

L’inscription, connexion, déconnexion, récupération de session et OAuth sont gérés par Supabase Auth. Les fournisseurs Google et Apple ne fonctionnent que s’ils sont activés/configurés dans Supabase. Pour les liens de confirmation et de réinitialisation, ajoute les URL locales et celles de production à la liste des URL de redirection autorisées dans Supabase Auth. En local Docker, l’URL d’interface par défaut est `http://localhost:8080`; avec Vite, `http://localhost:5173`.

## Vérification disponible

```powershell
npm test
npm run build
```

Les tests frontend utilisent le runner intégré de Node.js 24 pour couvrir les déplacements locaux, les portées d’attaque, les calculs de combat et la simulation d’actions d’analyse. Les tests des règles autoritaires, de la persistance et des routes API sont dans `backend/tests/`.
