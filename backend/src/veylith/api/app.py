from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from veylith.api.routes_auth import router as auth_router
from veylith.api.routes_games import router as games_router
from veylith.api.routes_health import router as health_router
from veylith.api.routes_social import (
    friends_router,
    invitations_router,
    users_router,
)

app = FastAPI(
    title="Veylith API",
    description="API HTTP du moteur de jeu Veylith.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/api")
app.include_router(invitations_router, prefix="/api")
app.include_router(games_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(friends_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
