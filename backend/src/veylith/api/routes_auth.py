from typing import Any

from fastapi import APIRouter, Depends

from veylith.auth.dependencies import get_current_user

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.get("/me")
def get_me(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str | None]:
    return {"id": current_user["id"], "email": current_user["email"]}
