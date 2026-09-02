#!/usr/bin/env python3
"""Propose a folder for every bookmark under "Other bookmarks", by title + domain.

This is a STARTER classifier with neutral, well-known-domain rules. It is meant
to be tuned to your own collection — drop a `classify.rules.json` next to this
script (gitignored) to extend/override the built-in rules without editing code:

    {
      "domains": { "example.com": ["Dev", "Tools"] },
      "keywords": [ ["regex", ["Top", "Sub"]] ],
      "folders":  [ ["regex", ["Top", "Sub"]] ]
    }

Reads Chrome's AccountBookmarks (ids == chrome.bookmarks ids) and writes a
proposed-moves TSV. It MOVES NOTHING — feed the TSV to the `apply_moves` tool.

Env:
  BOOKMARKS_SRC   path to Chrome's AccountBookmarks (default: macOS Default profile)
  MOVES_OUT       output TSV path (default: ./proposed-moves.tsv)
"""
import json, os, re, csv, sys
from urllib.parse import urlparse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("BOOKMARKS_SRC",
    os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/AccountBookmarks"))
OUT = os.environ.get("MOVES_OUT", os.path.join(os.getcwd(), "proposed-moves.tsv"))

# ---------- neutral starter taxonomy: existing folder name -> (top, sub) ----
# Matched case-insensitively with KW-style word boundaries so path tokens like
# News / AI / Dev / Articles hit, but DETAILS / Newspaper / JavaScript do not.
FOLDER_RULES = [
    (r"\bWeb Dev\b|\bWeb Development\b|\bFrontend\b|\bFront-?end\b|\bAngular\b|\bReact\b|\bVue\b|\bTypeScript\b|\bWebPack\b|\bBootstrap\b", ("Dev", "Web")),
    (r"\bAWS\b|\bAzure\b|\bCloud\b|\bKubernetes\b|\bDocker\b|\bDevOps\b", ("Dev", "Cloud")),
    # Bare .NET rejects a word char immediately before the dot so example.net /
    # shop.net TLDs do not hit (#81). ASP.NET / VB.NET stay word-bound tokens
    # (Microsoft .NET, Learn ASP.NET). C# keeps letter-side \b.
    (r"\bASP\.NET\b|\bVB\.NET\b|(?<!\w)\.NET\b|\bC#|\bJava\b|\bPython\b|\bGolang\b|\bRust\b", ("Dev", "Languages")),
    (r"\bSoftware\b|\bProgramming\b|\bDev\b|\bEngineering\b", ("Dev", "")),
    (r"\bAI\b|\bLLM\b|\bMachine Learning\b|\bML\b", ("AI", "")),
    (r"\bGames?\b|\bGaming\b", ("Games", "")),
    (r"\bCrypto\b|\bTrading\b|\bStocks\b|\bFinance\b|\bInvesting\b", ("Finance", "")),
    (r"\bShopping\b|\bDeals\b|\bWishlist\b", ("Shopping", "")),
    (r"\bWork\b|\bProjects\b", ("Work", "")),
    (r"\bRecipes?\b|\bFood\b|\bCooking\b", ("Food", "")),
    (r"\bTravel\b|\bTrips\b|\bVacation\b", ("Travel", "")),
    (r"\bNews\b|\bPolitics\b", ("News", "")),
    (r"\bMusic\b", ("Music", "")),
    (r"\bDesign\b|\bArt\b|\bInspiration\b", ("Design", "")),
    (r"\bReading\b|\bArticles\b|\bReference\b|\bLearning\b", ("Reference", "")),
    (r"\bPersonal\b", ("Personal", "")),
]

# ---------- obvious junk (propose deletion) --------------------------------
JUNK_TITLES = {"google", "bing", "yahoo", "new tab", "untitled", "", "save to pocket",
               "sign in", "log in", "login", "loading", "page not found"}
JUNK_HOSTS = {"newtab", "localhost", "127.0.0.1"}

def is_junk(title, host):
    t = (title or "").strip().lower()
    if t in JUNK_TITLES: return True
    if host in JUNK_HOSTS: return True
    return False

def is_short_title_junk(title, host):
    t = (title or "").strip().lower()
    if len(t) <= 2: return True
    if host == "" and len(t) < 4: return True
    return False

# ---------- neutral domain -> (top, sub); well-known sites only -------------
D = {
    # dev
    "github.com": ("Dev", "GitHub"), "gitlab.com": ("Dev", "GitHub"), "bitbucket.org": ("Dev", "GitHub"),
    "stackoverflow.com": ("Dev", ""), "stackexchange.com": ("Dev", ""),
    "developer.mozilla.org": ("Dev", "Web"), "npmjs.com": ("Dev", "Web"), "pypi.org": ("Dev", ""),
    "learn.microsoft.com": ("Dev", ""), "docs.microsoft.com": ("Dev", ""),
    "docs.aws.amazon.com": ("Dev", "Cloud"), "aws.amazon.com": ("Dev", "Cloud"),
    "kubernetes.io": ("Dev", "Cloud"), "docker.com": ("Dev", "Cloud"),
    "dev.to": ("Dev", ""), "freecodecamp.org": ("Dev", ""), "css-tricks.com": ("Dev", "Web"),
    "smashingmagazine.com": ("Dev", "Web"), "jetbrains.com": ("Dev", "Tools"),
    # ai
    "openai.com": ("AI", ""), "chatgpt.com": ("AI", ""), "anthropic.com": ("AI", ""),
    "huggingface.co": ("AI", ""), "kaggle.com": ("AI", ""), "arxiv.org": ("Reference", "Papers"),
    # reference / news / social / media
    "wikipedia.org": ("Reference", ""), "medium.com": ("Reference", ""),
    "news.ycombinator.com": ("News", ""), "nytimes.com": ("News", ""), "bbc.com": ("News", ""),
    "reddit.com": ("Social", ""), "x.com": ("Social", ""), "twitter.com": ("Social", ""),
    "linkedin.com": ("Social", ""), "youtube.com": ("Media", "Video"), "vimeo.com": ("Media", "Video"),
    "netflix.com": ("Media", ""), "open.spotify.com": ("Music", ""), "spotify.com": ("Music", ""),
    # shopping / finance / productivity / design / games / travel / food
    "amazon.com": ("Shopping", ""), "ebay.com": ("Shopping", ""), "etsy.com": ("Shopping", ""),
    "investopedia.com": ("Finance", ""), "coinmarketcap.com": ("Finance", "Crypto"),
    "notion.so": ("Productivity", ""), "trello.com": ("Productivity", ""), "airtable.com": ("Productivity", ""),
    "figma.com": ("Design", ""), "dribbble.com": ("Design", ""), "behance.net": ("Design", ""),
    "store.steampowered.com": ("Games", ""), "ign.com": ("Games", ""),
    "airbnb.com": ("Travel", ""), "booking.com": ("Travel", ""), "tripadvisor.com": ("Travel", ""),
    "allrecipes.com": ("Food", ""), "seriouseats.com": ("Food", ""),
}

# ---------- neutral title-keyword rules -------------------------------------
# Word-bounded (same \b style as FOLDER_RULES) so crypto/stock/prompt/guide
# don't match cryptography/stockings/promptly/guidelines. Optional s? keeps
# stocks/recipes/flights. ChatGPT / Dockerfile are explicit so those
# compounds still hit after \bgpt\b / \bdocker\b.
KW = [
    (r"\breact\b|\bangular\b|\bvue\b|\btypescript\b|\bwebpack\b|\bcss\b|\bhtml\b|\bnode\.js\b|\bnpm\b", ("Dev", "Web")),
    (r"\bdocker\b|\bdockerfiles?\b|\bkubernetes\b|\baws\b|\bazure\b|\bterraform\b|\bserverless\b", ("Dev", "Cloud")),
    (r"\bdesign patterns?\b|\barchitectures?\b|\bmicroservices?\b|\brest apis?\b|\bgraphql\b", ("Dev", "Architecture")),
    (r"\bui\b|\bux\b|\bdesign systems?\b|\bfigma\b|\bwireframes?\b", ("Design", "")),
    (r"\bai\b|\bgpt\b|\bchatgpt\b|\bllm\b|\bmachine learning\b|\bneural\b|\bprompts?\b", ("AI", "")),
    (r"\bbitcoins?\b|\bethereum\b|\bcryptos?\b|\bstocks?\b|\betfs?\b|\bforex\b|\btrading\b", ("Finance", "")),
    (r"\brecipes?\b|\bvegan\b|\bdinners?\b|\bbaking\b", ("Food", "")),
    (r"\bflights?\b|\bhotels?\b|\bitinerary\b|\btravel guides?\b", ("Travel", "")),
    (r"\bresumes?\b|\bcover letters?\b|\bjobs?\b|\bhiring\b|\bcareers?\b", ("Work", "")),
    (r"\btutorials?\b|\bguides?\b|\bhow to\b|\breferences?\b|\bcheat ?sheets?\b", ("Reference", "")),
]

# ---------- optional local tuning: classify.rules.json (gitignored) ---------
# User folder regexes keep prior case-sensitive search (not re.IGNORECASE).
_USER_FOLDER_RULES = []

def normalize_host(h):
    h = (h or "").lower()
    if h.startswith("www."):
        h = h[4:]  # at most one leading www. label
    return h[:-1] if h.endswith(".") else h  # one trailing DNS root dot

def load_user_rules(cfg=None):
    if cfg is None:
        path = os.path.join(HERE, "classify.rules.json")
        if not os.path.exists(path):
            return
        cfg = json.load(open(path))
    # Same identity as host() so TitleCase / www. / WWW. keys override built-ins.
    # Skip keys that normalize to "" ("." / "www.") so they cannot match host("").
    for raw, pair in (cfg.get("domains") or {}).items():
        key = normalize_host(raw)
        if not key:
            continue
        D[key] = tuple(pair)
    for rx, pair in (cfg.get("keywords") or []):
        KW.insert(0, (rx, tuple(pair)))
    for rx, pair in (cfg.get("folders") or []):
        _USER_FOLDER_RULES.insert(0, (rx, tuple(pair)))

def host(u):
    try:
        return normalize_host(urlparse(u).hostname or "")
    except Exception: return ""

def classify(title, url, folder):
    t = (title or "").lower(); h = host(url)
    if is_junk(title, h): return "JUNK", "", "junk"
    # Skip folder rules for the Other bookmarks root and Unsorted holding
    # folders so domain/keyword can catalogue. Last segment, case-insensitive
    # identity — not Unsorted$ — so MyUnsorted is a real folder (#79).
    last = (folder or "").rsplit("/", 1)[-1]
    if last.lower() != "unsorted" and folder != "Other bookmarks":
        for rx, (tp, sb) in _USER_FOLDER_RULES:
            if re.search(rx, folder): return tp, sb, "folder"
        for rx, (tp, sb) in FOLDER_RULES:
            if re.search(rx, folder, flags=re.IGNORECASE): return tp, sb, "folder"
    # Longest matching suffix wins so user subdomain extends (gist.github.com)
    # beat earlier shorter parents (github.com). Insertion order is irrelevant.
    best = None
    for dom, (tp, sb) in D.items():
        if h == dom or h.endswith("." + dom):
            if best is None or len(dom) > best[0]:
                best = (len(dom), tp, sb)
    if best is not None:
        return best[1], best[2], "domain"
    # After domain match: short garbage on unknown / empty hosts stays junk.
    # A blanket len(t) <= 2 before this loop proposed DELETE? for HN / AI / JS / GH.
    if is_short_title_junk(title, h): return "JUNK", "", "junk"
    # User + built-in KW patterns share IGNORECASE so TitleCase rules.json
    # keywords still match the lowercased title (same leftover class as #73).
    for rx, (tp, sb) in KW:
        if re.search(rx, t, flags=re.IGNORECASE): return tp, sb, "keyword"
    return "Reference", "General", "weak"

def main():
    load_user_rules()
    d = json.load(open(SRC)); other = d["roots"]["other"]; rows = []
    def walk(n, path):
        for c in n.get("children", []):
            p = path + "/" + (c.get("name") or "")
            if c.get("type") == "url":
                tp, sb, how = classify(c.get("name"), c.get("url"), path)
                dest = "DELETE?" if tp == "JUNK" else f"Other bookmarks/{tp}" + (f"/{sb}" if sb else "")
                rows.append({"id": c["id"], "dest": dest, "cur": path, "how": how,
                             "title": c.get("name", ""), "url": c.get("url", "")})
            else:
                walk(c, p)
    walk(other, "Other bookmarks")

    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh, delimiter="\t"); w.writerow(["id", "proposed", "current", "via", "title", "url"])
        for r in rows: w.writerow([r["id"], r["dest"], r["cur"], r["how"], r["title"], r["url"]])

    print(f"classified {len(rows)} -> {OUT}\n=== top-level ===")
    for k, v in Counter(r["dest"].split("/")[1] if r["dest"] != "DELETE?" else "DELETE?" for r in rows).most_common():
        print(f"  {v:3d}  {k}")
    print("\n=== via ===")
    for k, v in Counter(r["how"] for r in rows).most_common(): print(f"  {v:3d}  {k}")

def _self_check():
    # Explicit raises so python -O cannot skip the checks.
    def expect(title, url, want, folder="Other bookmarks"):
        got = classify(title, url, folder)
        if got != want:
            raise AssertionError((url, folder, got, want))
    # Real host + subdomain still classify via domain identity.
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"))
    expect("Docs", "https://docs.github.com/en", ("Dev", "GitHub", "domain"))
    # Built-in longer suffix still beats a shorter parent (#71).
    expect("AWS Docs", "https://docs.aws.amazon.com/ec2",
           ("Dev", "Cloud", "domain"))
    expect("AWS", "https://aws.amazon.com", ("Dev", "Cloud", "domain"))
    expect("Amazon", "https://amazon.com", ("Shopping", "", "domain"))
    expect("Shop", "https://shop.amazon.com/x", ("Shopping", "", "domain"))
    # User subdomain extends win over shorter parents even when appended (#71).
    D["gist.github.com"] = ("Dev", "Gists")
    D["music.amazon.com"] = ("Music", "Amazon")
    try:
        expect("Gist", "https://gist.github.com/u/1", ("Dev", "Gists", "domain"))
        expect("Music", "https://music.amazon.com/abc",
               ("Music", "Amazon", "domain"))
        # Parents and unrelated subdomains still use the built-in pair.
        expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"))
        expect("Docs", "https://docs.github.com/en", ("Dev", "GitHub", "domain"))
        expect("Amazon", "https://www.amazon.com", ("Shopping", "", "domain"))
        # Deeper host under the user key still prefers the longer suffix.
        expect("Gist", "https://foo.gist.github.com/u/1",
               ("Dev", "Gists", "domain"))
    finally:
        del D["gist.github.com"]
        del D["music.amazon.com"]
    # Exact-key override of an existing host still replaces the built-in pair.
    saved = D["github.com"]
    D["github.com"] = ("Dev", "Override")
    try:
        expect("GitHub", "https://github.com", ("Dev", "Override", "domain"))
        expect("Docs", "https://docs.github.com/en", ("Dev", "Override", "domain"))
    finally:
        D["github.com"] = saved
    # User domain keys share host() identity so TitleCase / www. / WWW. override (#73).
    if normalize_host("GitHub.com") != host("https://www.github.com"):
        raise AssertionError(("GitHub.com", normalize_host("GitHub.com"),
                              host("https://www.github.com")))
    if normalize_host("www.github.com") != host("https://github.com"):
        raise AssertionError(("www.github.com", normalize_host("www.github.com"),
                              host("https://github.com")))
    if normalize_host("WWW.amazon.com") != host("https://www.amazon.com"):
        raise AssertionError(("WWW.amazon.com", normalize_host("WWW.amazon.com"),
                              host("https://www.amazon.com")))
    saved_gh, saved_az = D["github.com"], D["amazon.com"]
    try:
        load_user_rules({"domains": {"GitHub.com": ["Dev", "Title"]}})
        expect("GitHub", "https://www.github.com", ("Dev", "Title", "domain"))
        expect("Docs", "https://docs.github.com/en", ("Dev", "Title", "domain"))
        load_user_rules({"domains": {"www.github.com": ["Dev", "Title"]}})
        expect("GitHub", "https://github.com", ("Dev", "Title", "domain"))
        expect("GitHub", "https://www.github.com", ("Dev", "Title", "domain"))
        load_user_rules({"domains": {"WWW.amazon.com": ["Shopping", "Title"]}})
        expect("Amazon", "https://www.amazon.com", ("Shopping", "Title", "domain"))
        expect("Shop", "https://shop.amazon.com/x", ("Shopping", "Title", "domain"))
    finally:
        D["github.com"] = saved_gh
        D["amazon.com"] = saved_az
    # Keys that normalize to "" must not insert D[""] or steal empty URLs (#73).
    load_user_rules({"domains": {".": ["X", "Y"], "www.": ["X", "Y"]}})
    try:
        if "" in D:
            raise AssertionError(("empty domain key", D[""]))
        expect("x", "", ("JUNK", "", "junk"))
        expect("ab", "not-a-url", ("JUNK", "", "junk"))
        via = classify("Bookmark", "", "Other bookmarks")[2]
        if via == "domain":
            raise AssertionError(("", via))
    finally:
        D.pop("", None)
    # Leading www. still strips; real hosts stay via=domain.
    expect("GitHub", "https://www.github.com", ("Dev", "GitHub", "domain"))
    expect("Amazon", "https://www.amazon.com", ("Shopping", "", "domain"))
    # FQDN with one trailing DNS root dot still matches.
    expect("GitHub", "https://github.com./x", ("Dev", "GitHub", "domain"))
    expect("Docs", "https://docs.github.com./en", ("Dev", "GitHub", "domain"))
    # Short real titles on well-known hosts must still hit domain, not junk.
    expect("HN", "https://news.ycombinator.com", ("News", "", "domain"))
    expect("AI", "https://openai.com", ("AI", "", "domain"))
    expect("JS", "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
           ("Dev", "Web", "domain"))
    expect("GH", "https://github.com", ("Dev", "GitHub", "domain"))
    # Explicit junk lists stay first; short garbage still junk off known domains.
    expect("untitled", "https://github.com", ("JUNK", "", "junk"))
    expect("GitHub", "https://localhost", ("JUNK", "", "junk"))
    expect("x", "", ("JUNK", "", "junk"))
    expect("ab", "not-a-url", ("JUNK", "", "junk"))
    expect("XX", "https://random.invalid", ("JUNK", "", "junk"))
    expect("ab", "https://example.com", ("JUNK", "", "junk"))
    # Substring / suffix-injection / middle-label www. hosts must not.
    for url in ("https://notgithub.com", "https://github.com.evil.com",
                "https://myamazon.com", "https://xxbbc.com",
                "https://amazon.www.com", "https://docs.github.www.com"):
        via = classify("Bookmark", url, "Other bookmarks")[2]
        if via == "domain":
            raise AssertionError((url, via))
    # Folder-path substrings must not steal a known-domain hit (#67).
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/DETAILS")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/AVAILABLE")
    expect("Amazon", "https://amazon.com", ("Shopping", "", "domain"),
           folder="Other bookmarks/Newspaper")
    expect("Spotify", "https://spotify.com", ("Music", "", "domain"),
           folder="Other bookmarks/Musical")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/JavaScript")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/Cloudinary")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/Foodle")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/Artist")
    # Articles is a real segment (Reference), not the Art→Design substring hit.
    expect("GitHub", "https://github.com", ("Reference", "", "folder"),
           folder="Other bookmarks/Articles")
    # Genuine folder segments still win before domain (case-insensitive).
    expect("GitHub", "https://github.com", ("News", "", "folder"),
           folder="Other bookmarks/News")
    expect("GitHub", "https://github.com", ("News", "", "folder"),
           folder="Other bookmarks/news")
    expect("GitHub", "https://github.com", ("AI", "", "folder"),
           folder="Other bookmarks/AI")
    expect("GitHub", "https://github.com", ("Dev", "", "folder"),
           folder="Other bookmarks/Dev")
    # *.net TLD folder segments must not steal a known-domain hit (#81).
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/example.net")
    expect("Amazon", "https://amazon.com", ("Shopping", "", "domain"),
           folder="Other bookmarks/shop.net")
    expect("SO", "https://stackoverflow.com", ("Dev", "", "domain"),
           folder="Other bookmarks/stackoverflow.net")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/MySite.NET")
    # Genuine .NET / ASP.NET / VB.NET segments still win via=folder.
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/.NET")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/ASP.NET")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/VB.NET")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/ASP.NET Core")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/.net")
    # Descriptive prefixes still match, same as other token folder rules.
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/Microsoft .NET")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/Learn ASP.NET")
    expect("GitHub", "https://github.com", ("Dev", "Languages", "folder"),
           folder="Other bookmarks/Visual Basic VB.NET")
    # Unsorted holding folders skip folder rules so domain/keyword can run (#79).
    # Last segment is case-insensitive; TitleCase and variants all skip.
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/Unsorted")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/News/Unsorted")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/News/unsorted")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/Dev/UNSORTED")
    expect("GitHub", "https://github.com", ("Dev", "GitHub", "domain"),
           folder="Other bookmarks/AI/unsorted")
    # Compound last segments are not the holding folder (not Unsorted$).
    expect("GitHub", "https://github.com", ("News", "", "folder"),
           folder="Other bookmarks/News/MyUnsorted")
    # Unknown hosts under Unsorted still get keyword/weak, not parent folder.
    expect("Docker tutorial", "https://example.com/d",
           ("Dev", "Cloud", "keyword"),
           folder="Other bookmarks/News/unsorted")
    expect("Bookmark", "https://unknown.example/x",
           ("Reference", "General", "weak"),
           folder="Other bookmarks/News/UNSORTED")
    # User classify.rules.json folder regexes stay case-sensitive.
    _USER_FOLDER_RULES.insert(0, (r"^Other bookmarks/Work$", ("Work", "User")))
    try:
        expect("GitHub", "https://github.com", ("Work", "User", "folder"),
               folder="Other bookmarks/Work")
        # Lowercase misses the user override; built-in \bWork\b still hits.
        expect("GitHub", "https://github.com", ("Work", "", "folder"),
               folder="Other bookmarks/work")
    finally:
        del _USER_FOLDER_RULES[0]
    # Title-keyword substrings must not steal via=keyword on unknown hosts (#69).
    expect("Cryptography primer", "https://example.com/x",
           ("Reference", "General", "weak"))
    expect("Stockings sale", "https://shop.example.com/x",
           ("Reference", "General", "weak"))
    expect("Promptly delivered", "https://blog.example.com/a",
           ("Reference", "General", "weak"))
    expect("Guidelines for writing", "https://example.org/g",
           ("Reference", "General", "weak"))
    expect("Neuralgia treatment", "https://health.example.com/n",
           ("Reference", "General", "weak"))
    expect("Stockholm travel tips", "https://travel.example.net/s",
           ("Reference", "General", "weak"))
    expect("How tomatoes grow", "https://garden.example.com/t",
           ("Reference", "General", "weak"))
    expect("Flightless birds", "https://nature.example.com/f",
           ("Reference", "General", "weak"))
    # Genuine title tokens still hit via=keyword.
    expect("Docker tutorial", "https://example.com/d",
           ("Dev", "Cloud", "keyword"))
    expect("stock tips", "https://example.com/s",
           ("Finance", "", "keyword"))
    expect("travel guide", "https://example.com/t",
           ("Travel", "", "keyword"))
    expect("how to brew", "https://example.com/h",
           ("Reference", "", "keyword"))
    # Compounds that \bgpt\b / \bdocker\b alone would miss.
    expect("ChatGPT tips", "https://example.com/c",
           ("AI", "", "keyword"))
    expect("Dockerfile reference", "https://example.com/df",
           ("Dev", "Cloud", "keyword"))
    # Simple plurals the old substring rules already hit (s? + \b).
    expect("Five recipes", "https://example.com/r",
           ("Food", "", "keyword"))
    expect("Cheap flights", "https://example.com/fl",
           ("Travel", "", "keyword"))
    expect("Hotels in Paris", "https://example.com/hp",
           ("Travel", "", "keyword"))
    expect("Python tutorials", "https://example.com/p",
           ("Reference", "", "keyword"))
    expect("Writing guides", "https://example.com/w",
           ("Reference", "", "keyword"))
    expect("Cheat sheets", "https://example.com/cs",
           ("Reference", "", "keyword"))
    expect("design patterns", "https://example.com/dp",
           ("Dev", "Architecture", "keyword"))
    expect("microservices", "https://example.com/ms",
           ("Dev", "Architecture", "keyword"))
    expect("stocks", "https://example.com/st",
           ("Finance", "", "keyword"))
    # User classify.rules.json keywords share IGNORECASE so TitleCase overrides (#75).
    n_kw = len(KW)
    try:
        load_user_rules({"keywords": [[r"\bReact\b", ["Dev", "Override"]]]})
        expect("React hooks", "https://unknown.example/r",
               ("Dev", "Override", "keyword"))
        load_user_rules({"keywords": [[r"\bDocker\b", ["Dev", "Override"]]]})
        expect("Docker compose", "https://unknown.example/d",
               ("Dev", "Override", "keyword"))
        load_user_rules({"keywords": [[r"\bSvelte\b", ["Dev", "Web"]]]})
        expect("Svelte tutorial", "https://unknown.example/s",
               ("Dev", "Web", "keyword"))
        # Lowercase user KW still prepends and wins (same path as TitleCase).
        load_user_rules({"keywords": [[r"\breact\b", ["Dev", "Lower"]]]})
        expect("React hooks", "https://unknown.example/r",
               ("Dev", "Lower", "keyword"))
    finally:
        del KW[:len(KW) - n_kw]
    print("classify self-check ok")

if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        _self_check()
    else:
        main()

