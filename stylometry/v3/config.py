"""v3 configuration. Stdlib only.

CODE lives in the repo. DATA lives outside it. STYLO_V3_DATA points at the
data root (runs/, windows/, queue/, state/, labels.jsonl). Nothing under the
data root is ever committed: it contains message text and real entity names.
"""
import os
import pathlib

CODE_VERSION = "v3.0.0"

# ---- paths -----------------------------------------------------------------
CODE_ROOT = pathlib.Path(__file__).resolve().parent
DATA_ROOT = pathlib.Path(
    os.environ.get("STYLO_V3_DATA", os.path.expanduser("~/workspace/stylometry/v3"))
).resolve()

RUNS_DIR = DATA_ROOT / "runs"
WINDOWS_DIR = DATA_ROOT / "windows"
QUEUE_DIR = DATA_ROOT / "queue"
STATE_DIR = DATA_ROOT / "state"
AUDIT_DIR = DATA_ROOT / "audit"

ALERT_STATE = STATE_DIR / "alert_state.json"
LAYERB_STATE = STATE_DIR / "layerb_state.json"
CANDIDATES_LOG = DATA_ROOT / "entity_candidates.jsonl"
LABELS_LOG = DATA_ROOT / "labels.jsonl"
PENDING_QUEUE = QUEUE_DIR / "pending.jsonl"

# Artifacts ship WITH the code (schemas + build scripts); the built versions
# carrying real vocabulary are written to the data root and read from there
# first, falling back to the in-repo stub so imports never explode.
ENTITY_REGISTRY = DATA_ROOT / "entity_registry.json"
TOPIC_PROFILES = DATA_ROOT / "topic_profiles.json"
SEMANTIC_NULL = DATA_ROOT / "semantic_null.json"
ENTITY_REGISTRY_STUB = CODE_ROOT / "entity_registry.json"
TOPIC_PROFILES_STUB = CODE_ROOT / "topic_profiles.json"
SEMANTIC_NULL_STUB = CODE_ROOT / "semantic_null.json"

# ---- window semantics (v3-INDEPENDENT; see windows.py) ---------------------
TRAILING_HOURS = 4.0
TRAILING_N = 100
WINDOW_KINDS = ("trailing_hours", "trailing_n")
# Hard cap on messages handed to Layer B. Layer A scores the full window.
LAYER_B_MAX_MESSAGES = 240

# ---- tiers -----------------------------------------------------------------
LONGTAIL_TIER = "longtail"

# ---- Layer A thresholds ----------------------------------------------------
FLAG_PCTL = 0.975          # semantic_flag when max axis percentile crosses this
STRONG_PCTL = 0.99         # alert eligibility
MIN_WINDOW_TOKENS = 60     # below this, topic + discourse axes go unavailable
MIN_PROFILE_COVERAGE = 0.02
ENTITY_SURPRISE_CAP = 12.0
ENTITY_MIN_LAMBDA = 1e-4
MAD_FLOOR = 1e-6
ROUND_DP = 10              # every stored float is rounded here; replay is exact

# ---- alerting --------------------------------------------------------------
ALERT_COOLDOWN_SEC = 6 * 3600     # matches v2
LAYER_B_COOLDOWN_SEC = 90 * 60    # per (window_kind, dominant_axis): cost brake

# ---- calibration gate ------------------------------------------------------
CALIBRATION_MIN_EPISODES = 5      # distinct (label, date) pairs

# Terms that assert a state signature. While the gate is OPEN these are not
# allowed to reach a rendered joint_read. The model output is still archived.
BANNED_STATE_TERMS = (
    "relapse", "relapsing", "manic", "mania", "hypomanic", "depressive",
    "depression", "withdrawal", "withdrawing", "craving", "psychosis",
    "psychotic", "dysregulated", "dysregulation", "decompensating",
    "decompensation", "spiraling", "intoxicated", "using again", "high on",
    "sobriety", "detox", "bender", "binge",
)

# ---- Layer B ---------------------------------------------------------------
LAYER_B_MODEL = os.environ.get("STYLO_V3_MODEL", "claude-opus-5")
LAYER_B_MAX_TOKENS = 4000
LAYER_B_EFFORT = os.environ.get("STYLO_V3_EFFORT", "medium")
LAYER_B_TIMEOUT_SEC = 120
LAYER_B_MAX_RETRIES = 3
API_BASE = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
API_VERSION = "2023-06-01"

# temperature is REJECTED (HTTP 400) on every current model. See layer_b.py.
TEMPERATURE_CAPABLE_MODELS = ("claude-haiku-4-5",)

TRIGGERS = ("v2_flag", "v2_alert", "daily_digest", "manual")


def ensure_dirs():
    for d in (RUNS_DIR, WINDOWS_DIR, QUEUE_DIR, STATE_DIR, AUDIT_DIR):
        d.mkdir(parents=True, exist_ok=True)


def r(x):
    """Round a float for storage. Replay compares these exactly."""
    if x is None:
        return None
    return round(float(x), ROUND_DP)
