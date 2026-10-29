from functools import lru_cache

from supabase import Client, create_client
from veylith.auth.config import get_settings


@lru_cache
def get_supabase_client() -> Client:
    settings = get_settings()

    return create_client(settings.supabase_url, settings.supabase_anon_key)


@lru_cache
def get_supabase_admin_client() -> Client:
    """Client réservé au backend ; ne jamais exposer la clé au frontend."""
    settings = get_settings()
    return create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
    )
