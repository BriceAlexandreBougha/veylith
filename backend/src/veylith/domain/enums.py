from enum import Enum


class PlayerColor(str, Enum):
    WHITE = "WHITE"
    BLACK = "BLACK"


class PieceType(str, Enum):
    EXPLORER = "EXPLORER"
    VANGUARD = "VANGUARD"
    SENTINEL = "SENTINEL"


class TerrainMode(str, Enum):
    RANDOM = "RANDOM"
    MOUNTAINS = "MOUNTAINS"
    VALLEYS = "VALLEYS"
    HIGHLANDS = "HIGHLANDS"
    WOODS = "WOODS"
    DESERT = "DESERT"
