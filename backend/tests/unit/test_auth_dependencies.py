from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from supabase_auth.errors import AuthApiError

from veylith.auth import dependencies
from veylith.auth.config import Settings


def credentials() -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-token")


def test_invalid_supabase_token_remains_401(monkeypatch):
    class Auth:
        def get_user(self, _token):
            raise AuthApiError("invalid token", 401, "invalid_jwt")

    monkeypatch.setattr(
        dependencies, "get_supabase_client", lambda: SimpleNamespace(auth=Auth())
    )

    with pytest.raises(HTTPException) as error:
        dependencies.get_current_user(credentials())

    assert error.value.status_code == 401
    assert error.value.detail == "Jeton invalide ou expiré."


def test_supabase_connection_error_is_not_reported_as_bad_token(monkeypatch):
    class Auth:
        def get_user(self, _token):
            raise OSError("connection failed")

    monkeypatch.setattr(
        dependencies, "get_supabase_client", lambda: SimpleNamespace(auth=Auth())
    )

    with pytest.raises(HTTPException) as error:
        dependencies.get_current_user(credentials())

    assert error.value.status_code == 503
    assert "Supabase" in error.value.detail


def test_settings_env_file_is_independent_of_working_directory():
    env_file = Path(Settings.model_config["env_file"])

    assert env_file.is_absolute()
    assert env_file.name == ".env"
