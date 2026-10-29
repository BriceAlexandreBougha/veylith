from types import SimpleNamespace

from fastapi.testclient import TestClient
from supabase_auth.errors import AuthApiError

from veylith.api.app import app
from veylith.auth import dependencies


def test_private_api_routes_reject_missing_bearer_token(client):
    client.app.dependency_overrides.clear()

    for path in ("/api/auth/me", "/api/games", "/api/friends"):
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"


def test_auth_me_returns_identity_from_verified_supabase_user(client, monkeypatch):
    client.app.dependency_overrides.clear()
    verified_user = SimpleNamespace(
        id="00000000-0000-4000-8000-000000000099",
        email="player@example.com",
    )

    class Auth:
        def get_user(self, token):
            assert token == "valid-token"
            return SimpleNamespace(user=verified_user)

    monkeypatch.setattr(
        dependencies, "get_supabase_client", lambda: SimpleNamespace(auth=Auth())
    )

    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer valid-token"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": "00000000-0000-4000-8000-000000000099",
        "email": "player@example.com",
    }


def test_auth_me_rejects_invalid_supabase_token(client, monkeypatch):
    client.app.dependency_overrides.clear()

    class Auth:
        def get_user(self, _token):
            raise AuthApiError("invalid", 401, "invalid_jwt")

    monkeypatch.setattr(
        dependencies, "get_supabase_client", lambda: SimpleNamespace(auth=Auth())
    )

    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer expired-token"}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Jeton invalide ou expiré."


def test_auth_me_reports_supabase_outage_as_service_unavailable(client, monkeypatch):
    client.app.dependency_overrides.clear()

    class Auth:
        def get_user(self, _token):
            raise OSError("network unavailable")

    monkeypatch.setattr(
        dependencies, "get_supabase_client", lambda: SimpleNamespace(auth=Auth())
    )

    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer valid-looking-token"}
    )

    assert response.status_code == 503
    assert "Supabase" in response.json()["detail"]


def test_auth_dependency_without_token_does_not_call_supabase(monkeypatch):
    def unexpected_client():
        raise AssertionError("Supabase must not be called without credentials")

    monkeypatch.setattr(dependencies, "get_supabase_client", unexpected_client)
    client = TestClient(app)

    response = client.get("/api/auth/me")

    assert response.status_code == 401
    assert response.json()["detail"] == "Authentification requise."
