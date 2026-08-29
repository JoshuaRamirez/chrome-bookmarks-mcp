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
import json, os, re, csv
from urllib.parse import urlparse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("BOOKMARKS_SRC",
    os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/AccountBookmarks"))
OUT = os.environ.get("MOVES_OUT", os.path.join(os.getcwd(), "proposed-moves.tsv"))

# ---------- neutral starter taxonomy: existing folder name -> (top, sub) ----
FOLDER_RULES = [
    (r"Web Dev|Web Development|Frontend|Front-?end|Angular|React|Vue|TypeScript|WebPack|Bootstrap", ("Dev", "Web")),
    (r"AWS|Azure|Cloud|Kubernetes|Docker|DevOps", ("Dev", "Cloud")),
    (r"\.NET|C#|Java|Python|Golang|Rust", ("Dev", "Languages")),
    (r"Software|Programming|Dev\b|Engineering", ("Dev", "")),
    (r"AI|LLM|Machine Learning|ML\b", ("AI", "")),
    (r"Games?|Gaming", ("Games", "")),
    (r"Crypto|Trading|Stocks|Finance|Investing", ("Finance", "")),
    (r"Shopping|Deals|Wishlist", ("Shopping", "")),
    (r"Work|Projects", ("Work", "")),
    (r"Recipes?|Food|Cooking", ("Food", "")),
    (r"Travel|Trips|Vacation", ("Travel", "")),
    (r"News|Politics", ("News", "")),
    (r"Music", ("Music", "")),
    (r"Design|Art|Inspiration", ("Design", "")),
    (r"Reading|Articles|Reference|Learning", ("Reference", "")),
    (r"Personal", ("Personal", "")),
]

# ---------- obvious junk (propose deletion) --------------------------------
JUNK_TITLES = {"google", "bing", "yahoo", "new tab", "untitled", "", "save to pocket",
               "sign in", "log in", "login", "loading", "page not found"}
JUNK_HOSTS = {"newtab", "localhost", "127.0.0.1"}

def is_junk(title, host):
    t = (title or "").strip().lower()
    if t in JUNK_TITLES: return True
    if host in JUNK_HOSTS: return True
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
KW = [
    (r"\breact\b|\bangular\b|\bvue\b|typescript|webpack|css\b|html\b|node\.js|npm\b", ("Dev", "Web")),
    (r"docker|kubernetes|\baws\b|\bazure\b|terraform|serverless", ("Dev", "Cloud")),
    (r"design pattern|architecture|microservice|rest api|graphql", ("Dev", "Architecture")),
    (r"\bui\b|\bux\b|design system|figma|wireframe", ("Design", "")),
    (r"\bai\b|gpt|llm|machine learning|neural|prompt", ("AI", "")),
    (r"bitcoin|ethereum|crypto|stock|etf\b|forex|trading", ("Finance", "")),
    (r"recipe|vegan|dinner|baking", ("Food", "")),
    (r"flight|hotel|itinerary|travel guide", ("Travel", "")),
    (r"resume|cover letter|job\b|hiring|career", ("Work", "")),
    (r"tutorial|guide|how to|reference|cheat ?sheet", ("Reference", "")),
]

# ---------- optional local tuning: classify.rules.json (gitignored) ---------
def load_user_rules():
    path = os.path.join(HERE, "classify.rules.json")
    if not os.path.exists(path):
        return
    cfg = json.load(open(path))
    for host, pair in (cfg.get("domains") or {}).items():
        D[host] = tuple(pair)
    for rx, pair in (cfg.get("keywords") or []):
        KW.insert(0, (rx, tuple(pair)))
    for rx, pair in (cfg.get("folders") or []):
        FOLDER_RULES.insert(0, (rx, tuple(pair)))

def host(u):
    try: return (urlparse(u).hostname or "").replace("www.", "").lower()
    except Exception: return ""

def classify(title, url, folder):
    t = (title or "").lower(); h = host(url)
    if is_junk(title, h): return "JUNK", "", "junk"
    if not re.search(r"Unsorted$", folder) and folder != "Other bookmarks":
        for rx, (tp, sb) in FOLDER_RULES:
            if re.search(rx, folder): return tp, sb, "folder"
    for dom, (tp, sb) in D.items():
        if dom in h: return tp, sb, "domain"
    for rx, (tp, sb) in KW:
        if re.search(rx, t): return tp, sb, "keyword"
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

if __name__ == "__main__":
    main()
