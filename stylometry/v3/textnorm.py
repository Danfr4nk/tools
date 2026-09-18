"""Tokenization / normalization / sentence splitting. Stdlib only, deterministic.

Deliberately NOT v2's splitter.py: v2 splits for surface-style features and is
frozen. v3 needs its own, and a shared import would couple the two layers.
"""
import re
import unicodedata

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’\-]*|\d+(?:[.,]\d+)*")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+|\n+")
_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_HANDLE_RE = re.compile(r"[@#][A-Za-z0-9_]{2,}")
_WS_RE = re.compile(r"\s+")

# Capitalized-phrase candidate detection. Particles may appear internally.
_PARTICLES = frozenset({"of", "the", "de", "van", "von", "da", "del", "la", "and", "für", "für"})
_CAP_TOKEN_RE = re.compile(r"[A-Z][A-Za-z'’\-]{1,}|[A-Z]{2,}")


def nfkc(s):
    return unicodedata.normalize("NFKC", s or "")


def strip_noise(text):
    """Remove URLs and collapse whitespace. Handles are kept: they are entities."""
    t = nfkc(text)
    t = _URL_RE.sub(" ", t)
    return _WS_RE.sub(" ", t).strip()


def tokens(text):
    """Lowercased word tokens. The unit for every rate in Layer A."""
    return [m.group(0).lower() for m in _WORD_RE.finditer(strip_noise(text))]


def handles(text):
    return sorted({m.group(0).lower() for m in _HANDLE_RE.finditer(nfkc(text))})


def sentences(text):
    """Split on terminal punctuation and newlines. Empty fragments dropped."""
    t = nfkc(text).strip()
    if not t:
        return []
    parts = [p.strip() for p in _SENT_SPLIT_RE.split(t)]
    return [p for p in parts if p]


def cap_phrases(text, min_len=2, max_len=4):
    """Capitalized multi-word phrases -- candidate novel entities.

    Sentence-initial words are excluded from STARTING a phrase (they are
    capitalized by grammar, not by reference), but may be absorbed mid-phrase.
    Returns a list of surface phrases, order-stable, duplicates kept.
    """
    out = []
    for sent in sentences(text):
        toks = sent.split()
        if not toks:
            continue
        i = 0
        while i < len(toks):
            raw = toks[i].strip(".,;:!?\"'()[]{}“”‘’")
            if i == 0 or not _CAP_TOKEN_RE.fullmatch(raw):
                i += 1
                continue
            run = [raw]
            j = i + 1
            while j < len(toks) and len(run) < max_len:
                nxt = toks[j].strip(".,;:!?\"'()[]{}“”‘’")
                if _CAP_TOKEN_RE.fullmatch(nxt):
                    run.append(nxt)
                elif nxt.lower() in _PARTICLES and j + 1 < len(toks):
                    peek = toks[j + 1].strip(".,;:!?\"'()[]{}“”‘’")
                    if _CAP_TOKEN_RE.fullmatch(peek) and len(run) + 2 <= max_len:
                        run.append(nxt)
                        j += 1
                        continue
                    break
                else:
                    break
                j += 1
            if len(run) >= min_len:
                out.append(" ".join(run))
                i = j
            else:
                i += 1
    return out


def norm_key(phrase):
    """Identity key for a name. Casefold + collapse whitespace + strip punctuation.

    Deliberately conservative: it does NOT stem, drop particles, or reorder.
    Two names that differ by more than case/space/punctuation are two names.
    """
    t = nfkc(phrase).casefold()
    t = re.sub(r"[.,;:!?\"'()\[\]{}“”‘’]", "", t)
    return _WS_RE.sub(" ", t).strip()
