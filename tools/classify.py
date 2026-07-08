#!/usr/bin/env python3
"""Classify Other-Bookmarks entries into an expanded taxonomy.
Reads live AccountBookmarks (ids == chrome.bookmarks ids), proposes a target
folder per bookmark, flags junk and low-confidence guesses. Moves NOTHING.
Rules were authored after reading the full long tail.
"""
import json, os, re, csv
from urllib.parse import urlparse
from collections import Counter

SRC = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/AccountBookmarks")
OUT = os.path.expanduser("~/.local/share/chrome-bookmarks-mcp/backups/proposed-moves.tsv")

# ---------- existing well-named folders -> taxonomy (high confidence) -------
FOLDER_RULES = [
    (r"Angular", ("Dev","Web")), (r"TypeScript", ("Dev","Web")), (r"WebPack", ("Dev","Web")),
    (r"ASP\.NET|Web API|Bootstrap|ChartJs|RWD|React|Web Dev|Web Development|Important Knowledge", ("Dev","Web")),
    (r"/AWS", ("Dev","Cloud")), (r"/Blazor", ("Dev",".NET")), (r"/C#", ("Dev",".NET")),
    (r"Software Development", ("Dev","")),
    (r"Obsidian", ("Tools & Productivity","Obsidian")),
    (r"Skyrim", ("Games","Skyrim & Mods")), (r"Eve", ("Games","Eve Online")),
    (r"Factorio", ("Games","Factorio")), (r"Albion", ("Games","Albion")),
    (r"\bTSM\b|TradeSkill", ("Games","WoW")), (r"/Games", ("Games","")),
    (r"Crypto", ("Business & Trading","Crypto")), (r"Algo Trading", ("Business & Trading","Trading")),
    (r"AIA Resources|Shirt Stuff|Online Marketing|/Business", ("Business & Trading","")),
    (r"Gnostic", ("Spiritual & Esoteric","Gnostic")), (r"Spiritual", ("Spiritual & Esoteric","")),
    (r"Weaponry", ("Shopping","Weaponry")), (r"/Shopping", ("Shopping","")),
    (r"AI Tools", ("AI","Tools")), (r"AI News", ("AI","News")), (r"/AI\b", ("AI","")),
    (r"BBC", ("Work","BBC")), (r"/Reading", ("Work","Reading")), (r"/RCX", ("Work","RCX")),
    (r"/Work", ("Work","")), (r"/Personal", ("Personal & Media","")),
    (r"Literature", ("Reference & Learning","Writing")),
    (r"Code Tools", ("Dev","Tools")),
]

# ---------- obvious junk (propose deletion) --------------------------------
def is_junk(title, host):
    t = (title or "").strip().lower()
    if t in {"google","bing","yahoo","new tab","save to pocket","`","w","blu","apple",
             "checking link","hub","all courses","galleries"}: return True
    if host in {"newtab","localhost","ww42.speedtest.com"}: return True
    if len(t) <= 2: return True
    if host == "" and len(t) < 4: return True
    return False

# ---------- domain -> (top, sub) -------------------------------------------
D = {
 # dev
 "github.com":("Dev","GitHub"), "stackoverflow.com":("Dev",""), "learn.microsoft.com":("Dev",""),
 "docs.microsoft.com":("Dev",""), "msdn.microsoft.com":("Dev",""), "developer.microsoft.com":("Dev",""),
 "docs.aws.amazon.com":("Dev","Cloud"), "aws.amazon.com":("Dev","Cloud"), "developer.nvidia.com":("Dev",""),
 "nvidia.com":("Dev",""), "npmjs.com":("Dev","Web"), "devhints.io":("Dev",""), "grymoire.com":("Dev",""),
 "yamltools.dev":("Dev","Tools"), "objectmentor.com":("Dev","Architecture"), "destroyallsoftware.com":("Dev",""),
 "derickbailey.com":("Dev","Web"), "christianalfoni.github.io":("Dev","Web"), "recursion.org":("Dev","Dataviz"),
 "dashingd3js.com":("Dev","Dataviz"), "bost.ocks.org":("Dev","Dataviz"), "vallandingham.me":("Dev","Dataviz"),
 "academind.com":("Dev","Web"), "hueypetersen.com":("Dev","Web"), "sinonjs.org":("Dev","Web"),
 "allthingsdistributed.com":("Dev","Architecture"), "engineering.fb.com":("Dev",""), "pozorvlak.livejournal.com":("Dev",""),
 "neo4j.com":("Dev",""), "repl.it":("Dev","Tools"), "runkit.com":("Dev","Tools"), "webapplog.com":("Dev","Web"),
 "vanillajstoolkit.com":("Dev","Web"), "microjs.com":("Dev","Web"), "agiledesigners.com":("Dev","Web"),
 "frontendchecklist.com":("Dev","Web"), "scotch.io":("Dev","Web"), "helloreverb.com":("Dev",""),
 "avro.apache.org":("Dev",""), "behrankankul.com":("Dev",""), "pixelhandler.com":("Dev","Web"),
 "giantflyingsaucer.com":("Dev","Web"), "stackshare.io":("Dev","Tools"), "jetbrains.com":("Dev","Tools"),
 "arc.dev":("Dev","Career"), "dev.to":("Dev",""), "postman":("Dev","Tools"), "layer8.space":("Dev",""),
 "uneed.best":("Tools & Productivity",""), "iso.org":("Dev","Standards"), "segoldmine.ppi-int.com":("Dev","Standards"),
 "bankinfosecurity.com":("Dev","Security"), "thoughtworks.com":("Dev","Process"), "agileconnection.com":("Dev","Process"),
 "hci-itil.com":("Dev","Process"), "open.edu":("Reference & Learning",""), "cmi.ac.in":("Dev","Web"),
 "java.dzone.com":("Dev","Architecture"), "st-cs.illinois.edu":("Dev","Architecture"), "heim.ifi.uio.no":("Dev","Architecture"),
 "claudemarketplaces.com":("AI","Tools"), "mage.ai":("AI","Tools"), "aragon.ai":("AI","Tools"),
 "whataicandotoday.com":("AI",""), "visual-literacy.org":("Dev","Dataviz"), "seeing-theory.brown.edu":("Reference & Learning","Math"),
 "thoughtco.com":("Reference & Learning",""), "ia.net":("Dev","UI/UX"), "uxdesign.cc":("Dev","UI/UX"),
 "marvelapp.com":("Dev","UI/UX"), "developer.apple.com":("Dev","UI/UX"), "help.apple.com":("Dev",""),
 "support.apple.com":("Dev",""), "appleinsider.com":("Dev",""), "developer.x.com":("Dev",""), "caret":("Dev","Tools"),
 # ai/productivity tools
 "airtable.com":("Tools & Productivity","Apps"), "blog.trello.com":("Tools & Productivity","Apps"),
 "nla.zapier.com":("Tools & Productivity","Apps"), "descript.com":("Tools & Productivity","Apps"),
 "lastpass.com":("Tools & Productivity","Apps"), "windvane.io":("Tools & Productivity","Apps"),
 "flowrite.com":("Tools & Productivity","Apps"), "imperavi.com":("Tools & Productivity","Diagramming"),
 # games
 "d20pfsrd.com":("Games","RPGs"), "escapefromtarkov.com":("Games",""), "method.gg":("Games","WoW"),
 "mythictrap.com":("Games","WoW"), "wowhead.com":("Games","WoW"), "steamcommunity.com":("Games",""),
 "onlinefanatic.com":("Games",""), "hasanyilmaz.net":("Games",""), "subnautica.wikia.com":("Games",""),
 "mejoress.com":("Games",""), "wiki.screepspl.us":("Games","Screeps"), "screeps.com":("Games","Screeps"),
 "all-out.github.io":("Games","Eve Online"), "fuzzwork.co.uk":("Games","Eve Online"), "evemaps.dotlan.net":("Games","Eve Online"),
 "wiki.eveuniversity.org":("Games","Eve Online"), "albiononline.com":("Games","Albion"), "arstechnica.com":("Games",""),
 # trading/business
 "forex.com":("Business & Trading","Trading"), "en.myfxchoice.com":("Business & Trading","Trading"),
 "quantinsti.com":("Business & Trading","Trading"), "macroption.com":("Business & Trading","Trading"),
 "investopedia.com":("Business & Trading","Trading"), "ta-lib.org":("Business & Trading","Trading"),
 "landing.hedgeye.com":("Business & Trading","Trading"), "monero.how":("Business & Trading","Crypto"),
 "blog.nem.io":("Business & Trading","Crypto"), "tailopez.com":("Business & Trading","Marketing"),
 "omgmachines.com":("Business & Trading","Marketing"), "brandflow.net":("Business & Trading","Marketing"),
 "consumer.hotmart.com":("Business & Trading","Marketing"), "fiverr.com":("Business & Trading",""),
 "faithwriters.com":("Business & Trading",""),
 # work (past employers)
 "becpsn.sharepoint.com":("Work","Bechtel"), "go.bechtel.com":("Work","Bechtel"),
 "outlook.office365.com":("Work","Bechtel"), "mail.google.com":("Work",""), "gohypergiant.app.box.com":("Work","Hypergiant"),
 "gohypergiant.atlassian.net":("Work","Hypergiant"), "earnin.zoom.us":("Work",""), "www54.sap.com":("Work",""),
 "ppi-int.com":("Work",""),
 # spiritual & esoteric
 "tarot-heritage.com":("Spiritual & Esoteric","Tarot"), "aeclectic.net":("Spiritual & Esoteric","Tarot"),
 "alchemywebsite.com":("Spiritual & Esoteric","Magick & Occult"), "green-door.narod.ru":("Spiritual & Esoteric","Tarot"),
 "marykgreer.com":("Spiritual & Esoteric","Tarot"), "gnosticteachings.org":("Spiritual & Esoteric","Gnostic"),
 "samaelgnosis.us":("Spiritual & Esoteric","Gnostic"), "gnosis.com":("Spiritual & Esoteric","Gnostic"),
 "omega-magick.com":("Spiritual & Esoteric","Magick & Occult"), "solomonicmagic.blogspot.com":("Spiritual & Esoteric","Magick & Occult"),
 "frater273.com":("Spiritual & Esoteric","Magick & Occult"), "necronomi.com":("Spiritual & Esoteric","Magick & Occult"),
 "graycloakgrimoires.com":("Spiritual & Esoteric","Magick & Occult"), "store.nephilimpress.com":("Spiritual & Esoteric","Magick & Occult"),
 "jwmt.org":("Spiritual & Esoteric","Magick & Occult"), "thelightinvisible.org":("Spiritual & Esoteric","Magick & Occult"),
 "lightofegypt.com":("Spiritual & Esoteric","Magick & Occult"), "archangels-and-angels.com":("Spiritual & Esoteric","Angels"),
 "tarrdaniel.com":("Spiritual & Esoteric","Magick & Occult"), "sananda.website":("Spiritual & Esoteric","Ascension & Channeling"),
 "goldenageofgaia.com":("Spiritual & Esoteric","Ascension & Channeling"), "welovemassmeditation.com":("Spiritual & Esoteric","Ascension & Channeling"),
 "2012portal.blogspot.com":("Spiritual & Esoteric","Ascension & Channeling"), "secretenergy.com":("Spiritual & Esoteric","Ascension & Channeling"),
 "earth-keeper.com":("Spiritual & Esoteric","Ascension & Channeling"), "subtle.energy":("Spiritual & Esoteric","Ascension & Channeling"),
 "spiritechs.com":("Spiritual & Esoteric","Ascension & Channeling"), "store.spiritechs.com":("Spiritual & Esoteric","Ascension & Channeling"),
 "astralquest.com":("Spiritual & Esoteric","Ascension & Channeling"), "lawofone.info":("Spiritual & Esoteric","Ascension & Channeling"),
 "groupofforty.com":("Spiritual & Esoteric","Ascension & Channeling"), "yashanet.com":("Spiritual & Esoteric","Gnostic & Biblical"),
 "yahushua.net":("Spiritual & Esoteric","Gnostic & Biblical"), "generationword.com":("Spiritual & Esoteric","Gnostic & Biblical"),
 "kenraggio.com":("Spiritual & Esoteric","Gnostic & Biblical"), "brotherofyeshua.com":("Spiritual & Esoteric","Gnostic & Biblical"),
 "mayimachronim.com":("Spiritual & Esoteric","Gnostic & Biblical"), "jewishvirtuallibrary.org":("Spiritual & Esoteric","Gnostic & Biblical"),
 "sacred-texts.com":("Spiritual & Esoteric","Magick & Occult"), "crystalinks.com":("Spiritual & Esoteric","Esoterica"),
 "scaredofhell.com":("Spiritual & Esoteric","Gnostic & Biblical"), "godsplan-today.com":("Spiritual & Esoteric","Gnostic & Biblical"),
 "psyche.com":("Spiritual & Esoteric","Magick & Occult"), "ideasolar.wordpress.com":("Spiritual & Esoteric","Esoterica"),
 "charlesjajarvis.com":("Spiritual & Esoteric","Esoterica"), "educate-yourself.org":("Spiritual & Esoteric","Esoterica"),
 "illuminated-illusions.com":("Spiritual & Esoteric","Esoterica"), "disclose.tv":("Spiritual & Esoteric","Esoterica"),
 "ancient-code.com":("Spiritual & Esoteric","Esoterica"), "amasci.com":("Spiritual & Esoteric","Esoterica"),
 "hubpages.com":("Spiritual & Esoteric","Esoterica"), "rusoaica.com":("Spiritual & Esoteric","Esoterica"),
 "teachings.genekeys.com":("Spiritual & Esoteric","Gene Keys"), "at37.wordpress.com":("Spiritual & Esoteric","Esoterica"),
 "otago.ac.nz":("Spiritual & Esoteric","Magick & Occult"), "mindful.org":("Health & Wellness","Mindfulness"),
 "samael":("Spiritual & Esoteric","Gnostic"), "ebonstorm.wordpress.com":("Spiritual & Esoteric","Esoterica"),
 "yumpu.com":("Spiritual & Esoteric","Magick & Occult"), "necronomi":("Spiritual & Esoteric","Magick & Occult"),
 # art & design
 "redbubble.com":("Art & Design",""), "pexels.com":("Art & Design","Stock"), "pixabay.com":("Art & Design","Stock"),
 "canva.com":("Art & Design","Color"), "color.adobe.com":("Art & Design","Color"), "danielmartindiaz.com":("Art & Design","Artists"),
 "gabrieldunne.com":("Art & Design","Artists"), "stefansoell.de":("Art & Design","Artists"), "metmuseum.org":("Art & Design",""),
 "feltron.com":("Art & Design",""), "yankodesign.com":("Art & Design",""), "generativeart.com":("Art & Design",""),
 "artsandculture.google.com":("Art & Design",""), "sparkladies.com":("Personal & Media",""), "nudeok.com":("Personal & Media",""),
 "spnzr.com":("Art & Design","Artists"), "kan.so":("Art & Design","Artists"), "discordapp.com":("Art & Design",""),
 "autodraw.com":("Art & Design",""), "uxpin.com":("Dev","UI/UX"), "dribbble":("Art & Design",""),
 # health & wellness
 "self.com":("Health & Wellness","Fitness"), "shop.lululemon.com":("Health & Wellness","Yoga"),
 "idyllic.ch":("Health & Wellness","Yoga"), "mudwtr.com":("Health & Wellness",""), "integralguide.com":("Health & Wellness",""),
 # food
 "rockymountainfoodtours.com":("Food & Local","Coffee"), "tasteofhome.com":("Food & Recipes",""),
 "minimalistbaker.com":("Food & Recipes",""), "greenling.com":("Food & Local",""),
 # local / travel / civic
 "eurekavacation.com":("Local & Travel",""), "csindy.com":("Local & Travel",""), "ridethecity.com":("Local & Travel",""),
 "austin.craigslist.org":("Local & Travel",""), "sanantonio.craigslist.org":("Music",""), "assets.austintexas.gov":("Local & Travel",""),
 "meetup.com":("Local & Travel",""), "carelinx.com":("Local & Travel",""), "dlnr.hawaii.gov":("Local & Travel",""),
 "leginfo.legislature.ca.gov":("Reference & Learning",""), "fra.dot.gov":("Reference & Learning",""),
 "streeteasy.com":("Home & Shopping",""), "chairish.com":("Home & Shopping",""), "huckberry.com":("Home & Shopping",""),
 "automobiles.honda.com":("Home & Shopping",""), "townbroadband.com":("Home & Shopping",""),
 # music
 "afrodrumming.com":("Music",""), "ttmintl.org":("Music",""), "pianoscales.org":("Music",""),
 # reference / science / language / news
 "gutenberg.org":("Reference & Learning","Books"), "archive.org":("Reference & Learning","Books"),
 "fluentin3months.com":("Reference & Learning","Language"), "livescience.com":("Reference & Learning","Science"),
 "space.com":("Reference & Learning","Science"), "news.mit.edu":("Reference & Learning","Science"),
 "spectrum.ieee.org":("Reference & Learning","Science"), "ncbi.nlm.nih.gov":("Reference & Learning","Science"),
 "research-repository.st-andrews.ac.uk":("Spiritual & Esoteric","Gnostic & Biblical"), "marquette.edu":("Reference & Learning",""),
 "nicole-brown.co.uk":("Reference & Learning","Academia"), "npr.org":("News & Politics",""),
 "georgiebc.wordpress.com":("News & Politics",""), "subscribe.theepochtimes.com":("News & Politics",""),
 "reaganlibrary.gov":("News & Politics",""), "blinkist.com":("Reference & Learning","Books"),
 "safaribooksonline.com":("Reference & Learning","Books"), "books.google.com":("Spiritual & Esoteric","Magick & Occult"),
 "issuu.com":("Spiritual & Esoteric","Magick & Occult"), "tailopez":("Business & Trading","Marketing"),
}

KW = [  # title keyword -> (top, sub)  (lowercased)
 (r"tarot", ("Spiritual & Esoteric","Tarot")),
 (r"enochian|grimoire|magick|occult|hermetic|alchem|solomonic|goetia|kabbalah|qaballah|qabalah", ("Spiritual & Esoteric","Magick & Occult")),
 (r"gnostic|nag hammadi|sefer|yetzira|trinosophia|emerald tablet|demiurge|anunnaki|samael|deuterocanonical|midrash|chiasm|revelation|genesis|messianic", ("Spiritual & Esoteric","Gnostic & Biblical")),
 (r"ascend|pleiadian|stardust|gaia|sananda|ra material|law of one|channel|meditation|crop circle|disclosure|cosmic", ("Spiritual & Esoteric","Ascension & Channeling")),
 (r"angel|archangel", ("Spiritual & Esoteric","Angels")),
 (r"gene keys", ("Spiritual & Esoteric","Gene Keys")),
 (r"d3\b|dataviz|visualization|bar chart", ("Dev","Dataviz")),
 (r"mvc|model-view|design pattern|swagger|rest api|express\.js|couchdb|graphql|observable|rxjs", ("Dev","")),
 (r"webpack|angular|typescript|vanilla js|front-end|frontend|css|node\.js|npm\b", ("Dev","Web")),
 (r"\bui\b|ux\b|interface guidelines|card design|design system", ("Dev","UI/UX")),
 (r"itil|itsm|kano|agile|operations management|engineering management", ("Dev","Process")),
 (r"\beve\b|wormhole|jita|dotlan|screeps", ("Games","Eve Online")),
 (r"skyrim|nexus|subnautica|tarkov|warcraft|wowhead|satisfactory|pathfinder|d20", ("Games","")),
 (r"forex|fibonacci|candlestick|rsi\b|pip\b|etf\b|technical analysis", ("Business & Trading","Trading")),
 (r"monero|bitcoin|ethereum|crypto|\bxem\b|\bnem\b", ("Business & Trading","Crypto")),
 (r"ghostwriter|marketing|entrepreneur|sales automation", ("Business & Trading","Marketing")),
 (r"yoga|ashtanga|lululemon|exercise|fitness", ("Health & Wellness","")),
 (r"recipe|vegan|soup|pasta", ("Food & Recipes","")),
 (r"coffee|study spot|colorado springs|austin|craigslist", ("Local & Travel","")),
 (r"djembe|piano|scales|drumming", ("Music","")),
 (r"color palette|stock photo|poster|gallery|infographic", ("Art & Design","")),
 (r"spanish|standard deviation|epistemology|methodology|wikipedia", ("Reference & Learning","")),
 (r"coup|election|geopolit|plunder", ("News & Politics","")),
 (r"obsidian|dataview|meta bind", ("Tools & Productivity","Obsidian")),
 (r"resume|remote job|jobs at|career", ("Dev","Career")),
]

def host(u):
    try: return (urlparse(u).hostname or "").replace("www.","").lower()
    except: return ""

def classify(title, url, folder):
    t=(title or "").lower(); h=host(url)
    if is_junk(title,h): return "JUNK","", "junk"
    if not re.search(r"Unsorted$", folder) and folder!="Other Bookmarks":
        for rx,(tp,sb) in FOLDER_RULES:
            if re.search(rx,folder): return tp,sb,"folder"
    for d,(tp,sb) in D.items():
        if d in h: return tp,sb,"domain"
    for rx,(tp,sb) in KW:
        if re.search(rx,t): return tp,sb,"keyword"
    return "Reference & Learning","General","weak"

d=json.load(open(SRC)); other=d["roots"]["other"]; rows=[]
def walk(n,path):
    for c in n.get("children",[]):
        p=path+"/"+(c.get("name") or "")
        if c.get("type")=="url":
            tp,sb,how=classify(c.get("name"),c.get("url"),path)
            dest="DELETE?" if tp=="JUNK" else f"Other Bookmarks/{tp}"+(f"/{sb}" if sb else "")
            rows.append({"id":c["id"],"dest":dest,"cur":path,"how":how,"title":c.get("name",""),"url":c.get("url","")})
        else: walk(c,p)
walk(other,"Other Bookmarks")

with open(OUT,"w",newline="") as fh:
    w=csv.writer(fh,delimiter="\t"); w.writerow(["id","proposed","current","via","title","url"])
    for r in rows: w.writerow([r["id"],r["dest"],r["cur"],r["how"],r["title"],r["url"]])

print(f"classified {len(rows)} -> {OUT}\n=== top-level ===")
for k,v in Counter(r["dest"].split("/")[1] if r["dest"]!="DELETE?" else "DELETE?" for r in rows).most_common():
    print(f"  {v:3d}  {k}")
print("\n=== via ===")
for k,v in Counter(r["how"] for r in rows).most_common(): print(f"  {v:3d}  {k}")
print("\n=== still weak/general (sample) ===")
for r in [r for r in rows if r["how"]=="weak"][:25]: print(f"  {r['title'][:62]} | {host(r['url'])}")
print("\n=== JUNK proposed for deletion ===")
for r in [r for r in rows if r["how"]=="junk"]: print(f"  {r['title'][:50]} | {host(r['url'])}")
