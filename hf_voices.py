"""
Online voice catalog — RVC models published on the Hugging Face Hub.

The Voices library used to show only what was already on this Mac, so getting a
new voice meant leaving the app, finding a `.pth` somewhere, and dragging it in.
This module is the other half: a browsable catalog of RVC models that are
already public on Hugging Face, and a one-click install into `voice_models/`.

Three things make this harder than "list the repos":

1. **Most `.pth` files on the Hub are not voices.** Popular collections like
   `Politrees/RVC_resources` are 116 `.pth` files that are almost all *pretrained
   bases* (`f0G40k.pth`, `D32k.pth`) plus training checkpoints (`G_2333.pth`).
   Listing those would fill the tab with models that cannot sing. `_is_voice()`
   throws them out by path, filename shape and size.

2. **A repo is not a voice.** Some repos hold exactly one voice
   (`model.pth` + `model.index`); others hold eighty. So the unit here is a
   *file*, not a repo, and each voice carries the repo it came from.

3. **Anonymous Hub calls are rate limited.** Every listing is cached to a JSON
   sidecar, and the expensive part (the candidate pool) is fetched once and then
   filtered, sorted and paged in memory.

No API key is required, and none is sent. `HF_TOKEN` is honoured if the user has
one in the environment, purely to raise their own rate limit.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable, Optional

import engine

HF_API = "https://huggingface.co/api"
HF_HOST = "https://huggingface.co"
USER_AGENT = "AI-Cover-Studio/1.0 (+local desktop app)"

CACHE_PATH = engine.DATA_DIR / "hf-cache.json"

# The candidate pool is stable for hours; a single voice's metadata never
# changes for a given commit, so it is cached against the repo sha instead.
POOL_TTL = 6 * 3600
SEARCH_TTL = 3600

# Bump when the shape of a pool entry changes, so an upgrade rebuilds rather
# than serving records the new code cannot read. Tree and metadata caches are
# keyed by commit and survive the bump, so a rebuild costs a few searches.
POOL_KEY = "pool:v4"

# Authors who publish one voice per repo with a machine-readable `metadata.json`
# (name, gender, category). They are the reason the category filter can be
# honest — the labels come from the uploader, not from guesses made here.
CATALOG_AUTHORS = ("binant",)

# Broad sweeps that surface the rest of the RVC ecosystem. Different phrasings
# genuinely return different repos, which is why there is more than one.
SEED_QUERIES = ("rvc voice", "rvc v2", "RVC model", "voice model rvc", "rvc")

# `.pth` files that exist to train other models, not to sing.
_PRETRAINED_HINTS = (
    "pretrain", "pretrained", "/base", "hubert", "rmvpe", "uvr", "titan",
    "vocoder", "discriminator", "/logs/", "checkpoint", "contentvec",
)
# f0G40k, G48k, D32k, f0D40k — the RVC pretrained naming convention.
_PRETRAINED_NAME = re.compile(r"^(f0)?[dg]_?\d+k", re.I)
# G_2333.pth / D_2333.pth — mid-training checkpoints.
_CHECKPOINT_NAME = re.compile(r"^[dg]_\d+$", re.I)

# An RVC voice is ~40–60 MB. The window is generous either side, but a 700 MB
# `.pth` is not a voice and a 200 KB one is a placeholder.
MIN_VOICE_BYTES = 5 * 1024 * 1024
MAX_VOICE_BYTES = 300 * 1024 * 1024

# Noise words in filenames that describe the *format*, not the voice.
_NOISE = re.compile(
    r"\b(rvc|rvcv2|v1|v2|mangio|applio|model|models|voice|ai|final|fixed|"
    r"\d+\s*epochs?|e\d+|\d+k|kk|pth|zip|"
    # Epoch and step markers uploaders leave on the name: 400e, 238e, 5600s.
    r"\d{3,}[a-z]|"
    # Dataset codes: s10010, S6235.
    r"[a-z]\d{4,}|"
    # A bare long number is a step count, never part of a name. Four digits or
    # fewer are left alone so "Blink 182" and "U2" survive.
    r"\d{5,})\b", re.I)

GENDERS = ("male", "female")

# Not every "voice model" is a voice.
#
# Bulk uploaders scrape zip archives and name the result after the song the
# audio came from. `RegalHyperus/DrumKitRVCModels` is a collection of *drum kit*
# models, and one uploader republished eleven of them as celebrity singers — so
# the catalog's "Shakira" was really the drum track from "Try Everything", and
# "Charlie Puth" was `December25thDrums.zip`. They convert audio into
# percussion, which is exactly why you cannot hear a singer in the result.
#
# The upstream `source_url` gives it away, and it is already in the metadata we
# fetch, so this costs nothing extra. Matched against the source filename, the
# source repo and the uploader's own model name.
_NON_VOICE = re.compile(
    r"drums?\b|drumkit|drum[_\-\s]?kit|percussion|instrumental\b", re.I)


def _looks_like_an_instrument(meta: dict) -> bool:
    haystack = " ".join(str(meta.get(k) or "") for k in
                        ("source_url", "model_name", "description"))
    return bool(_NON_VOICE.search(haystack))


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
def _load_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".hf_", suffix=".json", dir=str(CACHE_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, CACHE_PATH)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _cached(key: str, ttl: Optional[float], produce) -> Any:
    """
    Read `key` from the sidecar, or call `produce()` and store the result.

    `ttl=None` means "never expires", used for per-commit metadata.
    """
    cache = _load_cache()
    hit = cache.get(key)
    if hit and (ttl is None or time.time() - hit.get("_at", 0) < ttl):
        return hit.get("value")

    value = produce()
    cache = _load_cache()          # re-read: another thread may have written
    cache[key] = {"_at": time.time(), "value": value}
    try:
        _save_cache(cache)
    except OSError:
        pass
    return value


def clear_cache() -> None:
    """Forget everything, including per-commit data. Rarely what you want."""
    CACHE_PATH.unlink(missing_ok=True)


def refresh_catalog() -> None:
    """
    Re-read the catalog from the Hub, keeping everything that cannot have
    changed.

    File trees, `metadata.json` and portraits are keyed by commit sha or by a
    person's name — none of them go stale. Discarding those too turned Refresh
    into a ninety-second cold rebuild; keeping them makes it about twenty
    seconds of searches.
    """
    cache = _load_cache()
    for key in [k for k in cache if k.startswith(("pool:", "search:"))]:
        del cache[key]
    _pool_state["error"] = None
    _backfilled[0] = False
    try:
        _save_cache(cache)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _headers() -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _get_json(url: str, timeout: float = 30.0) -> Any:
    req = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RuntimeError(
                "Hugging Face is asking us to slow down. Wait a minute and try "
                "again — the catalog you already loaded still works."
            ) from exc
        raise RuntimeError(f"Hugging Face returned {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(
            "Couldn't reach Hugging Face. Check your internet connection."
        ) from exc


def _search_repos(params: dict) -> list[dict]:
    query = urllib.parse.urlencode({**params, "full": "true"})
    data = _get_json(f"{HF_API}/models?{query}")
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# Turning repos into voices
# ---------------------------------------------------------------------------
def _is_voice(path: str, size: Optional[int]) -> bool:
    """Is this `.pth` a singer, or part of the machinery that makes singers?"""
    low = path.lower()
    if not low.endswith(".pth"):
        return False
    if any(hint in f"/{low}" for hint in _PRETRAINED_HINTS):
        return False

    stem = Path(path).stem
    if _PRETRAINED_NAME.match(stem) or _CHECKPOINT_NAME.match(stem):
        return False
    # Size is only known from the tree endpoint; when absent, trust the name.
    if size is not None and not (MIN_VOICE_BYTES <= size <= MAX_VOICE_BYTES):
        return False
    return True


def _pretty(raw: str) -> tuple[str, Optional[str]]:
    """
    Turn a repo or file name into something a person would read, and pull out a
    gender if the uploader encoded one.

    `Donald_Trump__RVC_v2_`  → ("Donald Trump", None)
    `morgan_freeman-male`    → ("Morgan Freeman", "male")
    """
    text = re.sub(r"\.(pth|index)$", "", raw or "", flags=re.I)
    text = text.replace("_", " ").replace("-", " ").replace(".", " ")

    gender = None
    words = [w for w in text.split() if w]
    while words and words[-1].lower() in GENDERS:
        gender = words.pop().lower()
    for w in words:
        if w.lower() in GENDERS:
            gender = gender or w.lower()

    text = _NOISE.sub(" ", " ".join(words))
    text = re.sub(r"[()\[\]{}]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -_")
    if not text:
        text = re.sub(r"[_\-]+", " ", raw).strip() or raw
    # Leave deliberate capitalisation (JISOO, McCartney) alone; only lift names
    # that arrived entirely lower case.
    if text == text.lower():
        text = " ".join(w[:1].upper() + w[1:] for w in text.split())
    return text, gender


def _pick_index(pth: str, indexes: list[str]) -> str:
    """Match a `.pth` to its search index the way a human would read the tree."""
    if not indexes:
        return ""
    pdir, pstem = str(Path(pth).parent), Path(pth).stem

    same_dir = [i for i in indexes if str(Path(i).parent) == pdir]
    for i in same_dir:                       # exact stem, e.g. arijit.pth/arijit.index
        if Path(i).stem == pstem:
            return i
    for i in indexes:                        # prefix, e.g. zub.pth/zub_retrieval.index
        if Path(i).stem.startswith(pstem) or pstem.startswith(Path(i).stem):
            return i
    if len(same_dir) == 1:
        return same_dir[0]
    return indexes[0] if len(indexes) == 1 else ""


def _files_of(repo: dict) -> list[str]:
    return [s.get("rfilename", "") for s in (repo.get("siblings") or [])]


def _voices_from_repo(repo: dict) -> list[dict]:
    """Every installable voice inside one repo. Sizes come later, from the tree."""
    repo_id = repo.get("id") or repo.get("modelId") or ""
    if not repo_id:
        return []

    files = _files_of(repo)
    indexes = [f for f in files if f.lower().endswith(".index")]
    pths = [f for f in files if _is_voice(f, None)]
    if not pths:
        return []

    tags = [t for t in (repo.get("tags") or []) if ":" not in t]
    lowered = {t.lower() for t in tags}
    repo_name = repo_id.split("/")[-1]
    solo = len(pths) == 1

    out = []
    for pth in pths:
        # A one-voice repo is named by the repo; a collection is named by the
        # file, because "RVC_resources" tells you nothing about who is singing.
        source = repo_name if solo else Path(pth).name
        name, gender = _pretty(source)
        if not solo and name.lower() in ("model", "g", "d", ""):
            name = _pretty(repo_name)[0]

        for g in GENDERS:
            gender = gender or (g if g in lowered else None)

        out.append({
            "id": f"{repo_id}::{pth}",
            "repoId": repo_id,
            "author": repo.get("author") or repo_id.split("/")[0],
            "name": name,
            "pthPath": pth,
            "indexPath": _pick_index(pth, indexes),
            "size": None,
            "gender": gender,
            "category": _category_from(lowered),
            "language": None,
            "tags": tags[:8],
            "likes": repo.get("likes") or 0,
            "downloads": repo.get("downloads") or 0,
            "modified": repo.get("lastModified") or "",
            "sha": repo.get("sha") or "",
            "pageUrl": f"{HF_HOST}/{repo_id}",
            "voiceCount": len(pths),
        })
    return out


def _category_from(lowered: set[str]) -> Optional[str]:
    for cat in ("celebrity", "anime", "character", "singer", "politician",
                "cartoon", "game", "vtuber"):
        if cat in lowered:
            return cat
    return None


# ---------------------------------------------------------------------------
# Metadata enrichment (catalog authors only, page at a time)
# ---------------------------------------------------------------------------
def _fetch_metadata(repo_id: str, sha: str) -> dict:
    """
    Read a repo's `metadata.json` — the uploader's own description of the voice.

    Cached against the commit sha and never expired: for a given commit the file
    cannot change. Failures cache as `{}` so a repo without one is not re-fetched
    on every page turn.
    """
    def produce() -> dict:
        url = f"{HF_HOST}/{repo_id}/resolve/main/metadata.json"
        req = urllib.request.Request(url, headers=_headers())
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                data = json.loads(res.read().decode("utf-8", "replace"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    return _cached(f"meta:{repo_id}@{sha}", None, produce) or {}


def _enrich(voices: list[dict]) -> None:
    """Fill in name/gender/category from `metadata.json`, in place."""
    targets = [v for v in voices
               if v["author"] in CATALOG_AUTHORS and not v.get("_enriched")]
    if not targets:
        return

    with ThreadPoolExecutor(max_workers=12) as pool:
        metas = list(pool.map(lambda v: _fetch_metadata(v["repoId"], v["sha"]), targets))

    for voice, meta in zip(targets, metas):
        voice["_enriched"] = True
        if not meta:
            continue
        # A drum kit filed under a singer's name is worse than a missing entry:
        # it downloads, installs and converts without erroring, and only the
        # silence where the voice should be tells you something went wrong.
        voice["notAVoice"] = _looks_like_an_instrument(meta)
        # The uploader's own name is the better source, but it is not always
        # clean — bulk uploads carry names like "sebastian_sallow_238e_56168s"
        # straight off the training run. It goes through the same tidy-up as a
        # filename; a name that is already clean passes through untouched.
        if meta.get("model_name"):
            tidied = _pretty(str(meta["model_name"]))[0]
            voice["name"] = tidied or voice["name"]
        voice["gender"] = (meta.get("gender") or voice["gender"]) or None
        voice["category"] = (meta.get("category") or voice["category"]) or None
        voice["language"] = meta.get("language") or None


def _add_sizes(voices: list[dict]) -> None:
    """
    Attach real byte sizes from the repo tree, one request per repo.

    Sizes are not decoration: they are the only way to tell a 55 MB voice from a
    110 MB pretrained base that slipped past the name filter, and the only honest
    way to warn that a voice ships a 300 MB search index.
    """
    repos = {}
    for v in voices:
        if not v.get("_sized"):
            repos.setdefault((v["repoId"], v["sha"]), []).append(v)
    if not repos:
        return

    def tree(item) -> dict:
        (repo_id, sha), _ = item

        def produce():
            try:
                data = _get_json(
                    f"{HF_API}/models/{repo_id}/tree/main?recursive=true", timeout=20)
            except RuntimeError:
                return {}
            return {e["path"]: e.get("size") or 0
                    for e in data if isinstance(e, dict) and e.get("type") == "file"}

        return _cached(f"tree:{repo_id}@{sha}", None, produce) or {}

    with ThreadPoolExecutor(max_workers=6) as pool:
        trees = list(pool.map(tree, repos.items()))

    for (_, group), sizes in zip(repos.items(), trees):
        for v in group:
            v["_sized"] = True
            # A tree lookup is also the only honest check that the index exists.
            if v["indexPath"] and v["indexPath"] not in sizes:
                v["indexPath"] = ""
            pth = sizes.get(v["pthPath"]) or 0
            idx = (sizes.get(v["indexPath"]) or 0) if v["indexPath"] else 0
            v["pthSize"] = pth or None
            v["indexSize"] = idx or None
            # `size` is what the download will actually cost, index included.
            v["size"] = (pth + idx) or None


# ---------------------------------------------------------------------------
# Portraits
#
# Nothing on the Hub carries a picture of the voice: of 464 repos surveyed, 9
# held an image and most of those were screenshots of a config dialog, and no
# `metadata.json` has an image field at all. Wikipedia is the only real source,
# and only for people — so portraits are attempted for the `celebrity` category
# and nowhere else. Everything else is served by the generated tile in the UI,
# which is why a miss here is not a failure.
#
# Two rules keep this honest:
#   * only `type == "standard"` articles, so a disambiguation page ("Jennie")
#     never puts a stranger's face on a voice;
#   * only images under `/wikipedia/commons/`, the freely-licensed pool. The
#     `/wikipedia/en/` pool is non-free fair-use and is not ours to redisplay.
# ---------------------------------------------------------------------------
WIKI_REST = "https://en.wikipedia.org/api/rest_v1/page/summary/"
WIKI_API = "https://en.wikipedia.org/w/api.php"
COMMONS_MARKER = "/wikipedia/commons/"

PORTRAIT_DIR = engine.DATA_DIR / "portraits"


# Wikimedia asks that clients identify themselves and throttle. Firing a
# thread pool at the API earns an immediate 429, so requests are serialised
# behind a minimum interval — roughly ten a second, which the docs treat as
# polite and which costs about twelve seconds for the whole celebrity list, once.
WIKI_UA = ("Vocalis/3.0 (local desktop app; RVC voice browser) "
           "python-urllib")
_WIKI_MIN_INTERVAL = 0.25
WIKI_RETRIES = 3
_wiki_gate = threading.Lock()
_wiki_last = [0.0]


def _wiki_get(url: str) -> Optional[dict]:
    """
    Fetch from Wikipedia, distinguishing "no such article" from "couldn't ask".

    Returns the payload, or None for a definitive 404. Raises RuntimeError when
    the question could not be put — a 429, a timeout, a dropped connection. That
    distinction is the whole point: a definitive answer is cached forever, and a
    failure to ask must not be, or one rate-limited afternoon would permanently
    deny a portrait to every voice that happened to be in flight.
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": WIKI_UA, "Accept": "application/json",
    })

    for attempt in range(WIKI_RETRIES):
        with _wiki_gate:
            gap = time.monotonic() - _wiki_last[0]
            if gap < _WIKI_MIN_INTERVAL:
                time.sleep(_WIKI_MIN_INTERVAL - gap)
            _wiki_last[0] = time.monotonic()

        try:
            with urllib.request.urlopen(req, timeout=12) as res:
                return json.load(res)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            # A 429 is not a refusal, it is a request to wait — and Wikipedia
            # says how long (typically a few seconds). Giving up here is what
            # made Drake, Rihanna and Kanye West look like people without
            # photographs; they were only people we asked about too quickly.
            if exc.code == 429 and attempt < WIKI_RETRIES - 1:
                try:
                    wait = float(exc.headers.get("Retry-After") or 0)
                except (TypeError, ValueError):
                    wait = 0.0
                time.sleep(min(max(wait, 2.0 * (attempt + 1)), 10.0))
                continue
            raise RuntimeError(f"Wikipedia returned {exc.code}.") from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise RuntimeError("Wikipedia could not be reached.") from exc

    raise RuntimeError("Wikipedia is rate limiting us.")


def _wiki_summary(title: str) -> dict:
    url = WIKI_REST + urllib.parse.quote(title.replace(" ", "_"), safe="")
    return _wiki_get(url) or {}


def _wiki_search_titles(name: str, limit: int = 5) -> list[str]:
    """Ask Wikipedia's search which articles this name might mean."""
    params = urllib.parse.urlencode({
        "action": "query", "list": "search", "srsearch": name,
        "srlimit": str(limit), "format": "json",
    })
    data = _wiki_get(f"{WIKI_API}?{params}") or {}
    hits = (data.get("query") or {}).get("search") or []
    return [h.get("title", "") for h in hits if h.get("title")]


def _related(name: str, title: str) -> bool:
    """
    Is this article plausibly about the name we asked for?

    The guard that stops the search fallback wandering. Searching "Sharkl"
    returns "Ghory and Dixit" — a real article about real people, and utterly
    wrong. Requiring the name and the title to share a word keeps
    "Drake" → "Drake (musician)" while rejecting that.
    """
    a = {w for w in re.split(r"\W+", name.lower()) if len(w) > 2}
    b = {w for w in re.split(r"\W+", title.lower()) if len(w) > 2}
    return bool(a & b)


def _portrait_from(summary: dict, name: str) -> dict:
    """A usable portrait from a summary, or `{}`."""
    if summary.get("type") != "standard":
        return {}
    source = (summary.get("thumbnail") or {}).get("source") or ""
    if COMMONS_MARKER not in source:
        return {}
    page = ((summary.get("content_urls") or {}).get("desktop") or {}).get("page", "")
    return {"url": source, "title": summary.get("title") or name, "page": page}


def _resolve_portrait(name: str) -> dict:
    """The lookup itself. Raises RuntimeError if Wikipedia could not be asked."""
    found = _portrait_from(_wiki_summary(name), name)
    if found:
        return found

    # The direct title often is not the article: "J Hope" is filed as "J-Hope",
    # and a bare stage name like "Drake" or "Snoop" lands on a disambiguation
    # page whose *second* search hit is the person. So walk the results rather
    # than trusting the first, and stop at the first real article with a
    # freely-licensed photograph.
    for title in _wiki_search_titles(name):
        if not _related(name, title):
            continue
        found = _portrait_from(_wiki_summary(title), name)
        if found:
            return found
    return {}


def _lookup_portrait(name: str) -> dict:
    """
    Find a freely-licensed portrait for a person's name.

    `{}` means no confident match, which is an ordinary outcome. Only answers
    Wikipedia actually gave are remembered; a failure to reach it is retried
    next time rather than written down as a "no".
    """
    key = f"portrait:{name.lower()}"
    cache = _load_cache()
    if key in cache:
        return cache[key].get("value") or {}

    try:
        result = _resolve_portrait(name)
    except RuntimeError:
        return {}

    cache = _load_cache()
    cache[key] = {"_at": time.time(), "value": result}
    try:
        _save_cache(cache)
    except OSError:
        pass
    return result


def _mark_portrait_candidates(voices: list[dict]) -> None:
    """
    Flag which voices are worth asking Wikipedia about. Does no network at all.

    Resolving portraits eagerly was the obvious design and the wrong one: with
    Wikipedia's rate limiter asking for a few seconds' pause every so often, a
    hundred lookups took minutes, and every one of them sat in front of the
    listing the user was waiting for.

    So the list says only "this one is a person, it is worth a try", and the
    actual lookup happens when the browser requests the image — spread out,
    off the critical path, and independently per card. A miss is remembered
    forever, so it costs one request ever and then answers instantly.
    """
    for v in voices:
        person = (v.get("category") or "") == "celebrity"
        v["hasPortrait"] = person
        v["portraitName"] = v["name"] if person else ""


def portrait_credit(name: str) -> dict:
    """
    Where a portrait came from, for attribution. Only consults the cache, so
    opening Details never triggers a lookup or waits on Wikipedia.
    """
    hit = _load_cache().get(f"portrait:{(name or '').lower()}")
    value = (hit or {}).get("value") or {}
    return {"title": value.get("title", ""), "page": value.get("page", "")}


def portrait_path(name: str) -> Path:
    """Where a portrait lives on disk once fetched. One file per name, forever."""
    import hashlib
    key = hashlib.sha1(name.lower().encode("utf-8")).hexdigest()[:20]
    return PORTRAIT_DIR / f"{key}.img"


def fetch_portrait(name: str) -> Optional[Path]:
    """
    The cached portrait file for a name, downloading it the first time.

    Returns None when there is no match — the caller answers 404 and the UI keeps
    the tile it already drew.
    """
    dest = portrait_path(name)
    if dest.exists() and dest.stat().st_size:
        return dest

    hit = _lookup_portrait(name)
    if not hit.get("url"):
        return None

    PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(hit["url"], headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(".part")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            tmp.write_bytes(res.read())
        os.replace(tmp, dest)
        return dest
    except Exception:
        tmp.unlink(missing_ok=True)
        return None


# ---------------------------------------------------------------------------
# The candidate pool
# ---------------------------------------------------------------------------
def _dedupe(voices: Iterable[dict]) -> list[dict]:
    seen, out = set(), []
    for v in voices:
        if v["id"] in seen:
            continue
        seen.add(v["id"])
        out.append(v)
    return out


def _build_pool() -> list[dict]:
    """
    Everything browsable with no search term: the structured catalog authors plus
    a sweep of the wider RVC ecosystem. Fetched once every few hours.
    """
    def produce() -> list[dict]:
        repos: list[dict] = []
        for author in CATALOG_AUTHORS:
            try:
                repos += _search_repos({"author": author, "limit": 1000})
            except RuntimeError:
                pass
        for query in SEED_QUERIES:
            try:
                repos += _search_repos({"search": query, "limit": 100,
                                        "sort": "likes", "direction": "-1"})
            except RuntimeError:
                pass
        if not repos:
            raise RuntimeError(
                "Couldn't reach Hugging Face. Check your internet connection.")

        voices = _dedupe(v for repo in repos for v in _voices_from_repo(repo))

        # Sizing and enrichment happen here, once, rather than per page. It makes
        # the first browse of the day slower, but it is what lets the category
        # filter and the size filter see the whole catalog instead of one page —
        # a "Celebrity" tab that only knew about the current 30 rows would be
        # worse than no tab at all.
        _add_sizes(voices)
        voices = [v for v in voices
                  if v.get("pthSize") is None
                  or MIN_VOICE_BYTES <= v["pthSize"] <= MAX_VOICE_BYTES]
        _enrich(voices)
        dropped = [v for v in voices if v.get("notAVoice")]
        if dropped:
            engine.log.info("Dropped %d mislabelled non-voice model(s), e.g. %s",
                            len(dropped), ", ".join(v["name"] for v in dropped[:5]))
        voices = [v for v in voices if not v.get("notAVoice")]

        # Portraits run last: they key off the category that `_enrich` just set,
        # and only the ~120 celebrity entries are looked up.
        _mark_portrait_candidates(voices)
        return voices

    return _cached(POOL_KEY, POOL_TTL, produce)


# ---------------------------------------------------------------------------
# Warm-up
#
# A cold pool build is ~400 metadata reads and ~70 file trees: well over a
# minute. Blocking the Voices tab on that would look like a hang, so the build
# runs on a background thread and the tab serves whatever it already has. Once
# warm, every browse and filter is served from memory.
# ---------------------------------------------------------------------------
_pool_lock = threading.Lock()
_pool_state = {"building": False, "step": "", "error": None}


def _pool_cached() -> Optional[list[dict]]:
    """The pool as last built, however old. `None` if it has never been built."""
    hit = _load_cache().get(POOL_KEY)
    return hit.get("value") if hit else None


def _pool_is_stale() -> bool:
    hit = _load_cache().get(POOL_KEY)
    return not hit or time.time() - hit.get("_at", 0) >= POOL_TTL


def _warm_pool() -> None:
    """Kick off a build unless one is already running."""
    with _pool_lock:
        if _pool_state["building"]:
            return
        _pool_state.update(building=True, step="Reading the Hugging Face catalog",
                           error=None)

    def run() -> None:
        try:
            _build_pool()
            _pool_state["error"] = None
        except Exception as exc:  # noqa: BLE001 — surfaced to the UI as text
            engine.log.warning("Online voice catalog build failed: %s", exc)
            _pool_state["error"] = str(exc)
        finally:
            _pool_state.update(building=False, step="")

    threading.Thread(target=run, daemon=True).start()


def _pool() -> list[dict]:
    """
    Best available pool, refreshing in the background when it has gone stale.

    Never blocks on a rebuild if there is anything at all to show — a catalog a
    few hours out of date beats a spinner.
    """
    cached = _pool_cached()
    if cached is None:
        _warm_pool()
        return []
    if _pool_is_stale():
        _warm_pool()
    return cached


def _live_search(query: str) -> list[dict]:
    """A real Hub search, so the tab is not limited to the cached pool."""
    def produce() -> list[dict]:
        repos = []
        for params in ({"search": query, "limit": 100, "sort": "likes", "direction": "-1"},
                       {"search": f"{query} rvc", "limit": 60}):
            try:
                repos += _search_repos(params)
            except RuntimeError:
                pass
        return _dedupe(v for repo in repos for v in _voices_from_repo(repo))

    return _cached(f"search:{query.lower()}", SEARCH_TTL, produce)


# ---------------------------------------------------------------------------
# Public listing
# ---------------------------------------------------------------------------
SORTS = ("popular", "recent", "name")

_backfilled = [False]


def backfill_origins() -> int:
    """
    Give already-installed voices their provenance back.

    Voices downloaded before the library started recording where things came
    from have no category and no face. Their names still match the catalog, so
    the record can be reconstructed once, from the pool that is already in
    memory. Runs at most once per session and never overwrites a real record.
    """
    if _backfilled[0]:
        return 0
    pool = _pool_cached()
    if not pool:
        return 0                    # nothing to match against yet; try later
    _backfilled[0] = True

    import voices_manifest
    known = voices_manifest.load_origins()
    installed = set(engine.list_voice_models())
    filled = 0

    for v in pool:
        name = engine.safe_model_name(v["name"])
        if name not in installed or name in known:
            continue
        person = (v.get("category") or "") == "celebrity"
        voices_manifest.record_origin(
            name,
            repoId=v["repoId"],
            sourceUrl=v["pageUrl"],
            category=v.get("category") or "",
            gender=v.get("gender") or "",
            portraitName=v["name"] if person else "",
        )
        known[name] = True
        filled += 1

    if filled:
        engine.log.info("Recovered provenance for %d installed voice(s).", filled)
    return filled


def _popularity(v: dict) -> float:
    """
    Likes and downloads are facts about a *repo*, not about one voice inside it.

    Left raw, a 19-voice collection with 88 likes puts all 19 of its voices above
    a single-voice repo with 40 — the collection's popularity counted nineteen
    times over. Dividing by the number of voices in the repo asks the fairer
    question: how much of this repo's regard belongs to this one voice?
    """
    share = max(1, v.get("voiceCount") or 1)
    return (v["likes"] * 10 + v["downloads"]) / share


def _sort_key(mode: str):
    if mode == "name":
        return lambda v: v["name"].lower()
    if mode == "recent":
        return lambda v: v["modified"] or ""
    return lambda v: (_popularity(v), v["modified"] or "")


def categories() -> list[str]:
    """Categories actually present in the pool, so the filter never lies."""
    return sorted({v["category"] for v in (_pool_cached() or []) if v.get("category")})


def catalog(query: str = "", category: str = "", gender: str = "",
            sort: str = "popular", page: int = 1, page_size: int = 30) -> dict:
    """
    One page of online voices, enriched and marked up with what is already
    installed on this Mac.
    """
    query = (query or "").strip()
    voices = list(_pool())
    backfill_origins()
    if query:
        # The live search adds repos the pool never saw; the pool contributes
        # the structured entries whose real names only exist in metadata.json.
        voices = _dedupe(voices + _live_search(query))

    if query:
        needle = query.lower()
        voices = [v for v in voices
                  if needle in v["name"].lower()
                  or needle in v["repoId"].lower()
                  or any(needle in t.lower() for t in v["tags"])]
    if category:
        voices = [v for v in voices if (v["category"] or "") == category]
    if gender:
        voices = [v for v in voices if (v["gender"] or "") == gender]

    total = len(voices)
    voices.sort(key=_sort_key(sort if sort in SORTS else "popular"),
                reverse=sort != "name")

    page = max(1, int(page or 1))
    page_size = max(1, min(100, int(page_size or 30)))
    start = (page - 1) * page_size
    window = [dict(v) for v in voices[start:start + page_size]]

    # Pool entries arrive already enriched and these are no-ops. Live-search
    # results do not: they have never been through the pool build, so they need
    # sizing, metadata and a portrait here — which is what stops a searched-for
    # celebrity from looking poorer than a browsed-to one.
    _enrich(window)
    _add_sizes(window)
    # Live-search results skip the pool build, so the instrument check has to
    # run here too or a searched-for "Shakira" would still offer the drum kit.
    window = [v for v in window if not v.get("notAVoice")]
    _mark_portrait_candidates(window)

    installed = set(engine.list_voice_models())
    for v in window:
        v["installName"] = engine.safe_model_name(v["name"])
        v["installed"] = v["installName"] in installed
        v["hasIndex"] = bool(v["indexPath"])
        v.setdefault("hasPortrait", False)
        v.setdefault("portraitName", "")

    return {
        "voices": window,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": start + page_size < total,
        "categories": categories(),
        # The tab is usable while the catalog is still being read; saying so is
        # better than an empty list that looks like a failure.
        "building": bool(_pool_state["building"]),
        "buildStep": _pool_state["step"],
        "error": _pool_state["error"] if not total else None,
    }


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
def _download_file(repo_id: str, path: str, dest: Path,
                   progress_cb, span: tuple[float, float], label: str) -> None:
    """Stream one file down, reporting progress across `span` of the whole job."""
    url = f"{HF_HOST}/{repo_id}/resolve/main/{urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers=_headers())
    lo, hi = span

    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            total = int(res.headers.get("Content-Length") or 0)
            done = 0
            with open(dest, "wb") as out:
                while True:
                    chunk = res.read(1024 * 256)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    frac = (done / total) if total else 0.0
                    note = f"{done / 1e6:.0f} of {total / 1e6:.0f} MB" if total else ""
                    progress_cb(lo + (hi - lo) * frac, label, note)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Hugging Face wouldn't serve that file ({exc.code}). "
            "The model may have been removed or made private."
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("The download was interrupted. Try again.") from exc


def _header_warning(pth: Path) -> str:
    """
    Read the freshly downloaded model's own header and object if what it says
    about itself contradicts how it was published. Returns "" when all is well.
    """
    try:
        import torch
        engine._allow_legacy_torch_load()
        data = torch.load(str(pth), map_location="cpu", weights_only=False)
    except Exception:
        return ""                       # unreadable header is not a verdict
    if not isinstance(data, dict):
        return ""

    internal = str(data.get("model_name") or "").strip()
    if internal and _NON_VOICE.search(internal):
        return (f"This model calls itself “{internal}” — it looks like an "
                "instrument, not a voice. Converting with it will not produce "
                "singing.")

    # A very short training set is the other reliable tell of a poor model.
    length = str(data.get("dataset_length") or "")
    m = re.match(r"^(\d+):(\d+):(\d+)$", length)
    if m:
        seconds = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
        if 0 < seconds < 300:
            return (f"Trained on only {seconds // 60} min {seconds % 60} s of "
                    "audio, so it may not sound much like the real voice.")
    return ""


def install(repo_id: str, pth_path: str, index_path: str = "", name: str = "",
            category: str = "", gender: str = "", portrait_name: str = "",
            progress_cb=None, log_cb=None) -> dict:
    """
    Download one voice from the Hub and install it into `voice_models/`.

    Downloads land in a temp directory first and are only handed to
    `engine.import_voice_bundle` once both files are complete, so a dropped
    connection can never leave a half-written model in the library.
    """
    progress = progress_cb or (lambda *a, **k: None)
    log = log_cb or (lambda *a, **k: None)

    if not repo_id or not pth_path:
        raise ValueError("Choose a voice to download.")

    safe = engine.safe_model_name(name or Path(pth_path).stem)
    if (engine.MODELS_DIR / f"{safe}.pth").exists():
        raise FileExistsError(f"A voice named '{safe}' is already installed.")

    work = Path(tempfile.mkdtemp(prefix="hfvoice_", dir=engine.OUTPUT_DIR))
    try:
        progress(0.02, "Contacting Hugging Face", repo_id)
        log(f"Downloading {repo_id}/{pth_path}")

        # The index is the smaller file but the bigger share of a good result;
        # the split reflects bytes, not importance.
        pth_span = (0.05, 0.75 if index_path else 0.95)
        local_pth = work / "voice.pth"
        _download_file(repo_id, pth_path, local_pth, progress, pth_span,
                       "Downloading the voice")

        local_index = ""
        if index_path:
            log(f"Downloading {repo_id}/{index_path}")
            dest = work / "voice.index"
            _download_file(repo_id, index_path, dest, progress, (0.75, 0.95),
                           "Downloading the pitch index")
            local_index = str(dest)

        # Last line of defence. The uploader's metadata can be wrong in ways the
        # source URL does not reveal, but the model's own header carries the
        # name it was trained under — "Charlie Puth" turned out to be
        # "December25thDrums". Checking costs nothing here: the file is local
        # and about to be read anyway.
        warning = _header_warning(local_pth)

        progress(0.97, "Installing", safe)
        result = engine.import_voice_bundle(str(local_pth), local_index, safe)
        result["warning"] = warning
        result["repoId"] = repo_id
        result["sourceUrl"] = f"{HF_HOST}/{repo_id}"

        # Carry the catalog's knowledge across into the library, so the voice
        # keeps its category, its gender and its face once it lands here.
        import voices_manifest
        voices_manifest.record_origin(
            safe,
            repoId=repo_id,
            sourceUrl=f"{HF_HOST}/{repo_id}",
            category=category,
            gender=gender,
            portraitName=portrait_name,
        )
        progress(1.0, "Ready to sing", safe)
        log(f"Installed '{safe}'.")
        return result
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
