#!/usr/bin/env python3
"""
Restore lost ratings into the live D1 via the MCP endpoint.

Input: old-ratings.json  -- produced by:
  npx wrangler d1 execute d1-mcp-db --remote --json \
    --command "SELECT r.rating, r.review, r.created_at, m.title, m.type, m.author_creator \
               FROM ratings r JOIN media_items m ON m.id = r.media_id" > old-ratings.json

What it does:
  * Reads the old (recovered) ratings.
  * Loads the CURRENT media_items from the live DB via the MCP.
  * Matches each old rating to a current media_id by title (+creator/type), with
    fuzzy fallback to survive the catalog rebuild (old "Artist Title" vs new "Title").
  * Skips any media that already has a rating (respects UNIQUE(user_id, media_id) and
    never clobbers today's data).
  * Inserts the recovered rating/review, preserving the original created_at.

Dry-run by default. Add --apply to write.

Env:
  MCP_URL    (default https://d1-mcp.cobiadigital.workers.dev/mcp)
  MCP_TOKEN  (default value of MCP_AUTH_TOKEN env, else "")
"""
import json, os, sys, re, difflib, urllib.request

MCP = os.environ.get("MCP_URL", "https://d1-mcp.cobiadigital.workers.dev/mcp")
TOKEN = os.environ.get("MCP_TOKEN", os.environ.get("MCP_AUTH_TOKEN", ""))
APPLY = "--apply" in sys.argv
INFILE = next((a for a in sys.argv[1:] if not a.startswith("-")), "old-ratings.json")
UA = {"User-Agent": "Mozilla/5.0 (d1-mcp-restore)"}


def mcp(sql, params):
    p = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "execute_sql", "arguments": {"sql": sql, "params": params}}}
    req = urllib.request.Request(MCP, data=json.dumps(p).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, **UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)["result"]
    if res.get("isError"):
        raise RuntimeError(res["content"][0]["text"])
    txt = res["content"][0]["text"]
    return json.loads(txt)["rows"] if txt.strip().startswith("{") else []


def norm(s):
    s = (s or "").lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", "", s)
    s = re.sub(r"\b(deluxe|expanded|remaster(ed)?|anniversary|edition|version|self-?titled)\b", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def parse_old(path):
    """Accept either a raw rows array, or wrangler's [{results:[...]}] shape."""
    data = json.load(open(path))
    if isinstance(data, dict):
        data = [data]
    rows = []
    if isinstance(data, list) and data and isinstance(data[0], dict) and "results" in data[0]:
        for blk in data:
            rows.extend(blk.get("results", []))
    else:
        rows = data
    return rows


def main():
    old = parse_old(INFILE)
    print(f"old ratings loaded: {len(old)}")

    cur = mcp("SELECT id,title,type,author_creator FROM media_items", [])
    # current user id + media ids already rated (to skip)
    urows = mcp("SELECT user_id, COUNT(*) c FROM ratings GROUP BY user_id ORDER BY c DESC", [])
    user_id = urows[0]["user_id"] if urows else 1
    rated = {r["media_id"] for r in mcp("SELECT media_id FROM ratings", [])}
    print(f"current media={len(cur)}  user_id={user_id}  already-rated media={len(rated)}")

    # build lookup maps over current catalog
    by_title_creator, by_combo, by_title = {}, {}, {}
    combo_keys = []
    for m in cur:
        t, c = norm(m["title"]), norm(m["author_creator"])
        by_title_creator.setdefault((t, c), m["id"])
        by_title.setdefault(t, m["id"])
        combo = norm(f"{m['author_creator'] or ''} {m['title']}")
        by_combo.setdefault(combo, m["id"])
        combo_keys.append((combo, m["id"]))

    def match(o):
        ot, oc, oty = o.get("title"), o.get("author_creator"), o.get("type")
        nt, nc = norm(ot), norm(oc)
        ncombo = norm(f"{oc or ''} {ot}")
        # 1 exact title+creator
        if (nt, nc) in by_title_creator:
            return by_title_creator[(nt, nc)], "title+creator"
        # 2 old concatenated "Artist Title" vs current combo
        if ncombo in by_combo:
            return by_combo[ncombo], "combo"
        # 3 old title alone vs current combo (old title may be "Artist Title")
        if nt in by_combo:
            return by_combo[nt], "title=combo"
        # 4 unique title
        if nt in by_title:
            return by_title[nt], "title"
        # 5 fuzzy on combined string
        cands = difflib.get_close_matches(ncombo or nt, [c for c, _ in combo_keys], n=1, cutoff=0.9)
        if cands:
            mid = dict(combo_keys)[cands[0]]
            return mid, "fuzzy"
        return None, "UNMATCHED"

    to_insert, skipped, unmatched = [], [], []
    for o in old:
        mid, how = match(o)
        if mid is None:
            unmatched.append(o); continue
        if mid in rated:
            skipped.append((o, mid, how)); continue
        to_insert.append((o, mid, how))
        rated.add(mid)  # avoid double-insert within this batch

    print(f"\nplan: insert={len(to_insert)} skip(existing)={len(skipped)} unmatched={len(unmatched)}")
    print("\n-- WILL INSERT --")
    for o, mid, how in to_insert:
        rev = (o.get("review") or "")[:40]
        print(f"  media={mid:<4} score={o.get('rating')} [{how}] {o.get('author_creator') or ''} - {o.get('title')}  rev:{rev}")
    if unmatched:
        print("\n-- UNMATCHED (need manual mapping) --")
        for o in unmatched:
            print(f"  score={o.get('rating')} {o.get('type')} | {o.get('author_creator') or ''} - {o.get('title')}")

    if APPLY:
        ok = 0
        for o, mid, how in to_insert:
            try:
                mcp("INSERT INTO ratings (user_id, media_id, rating, review, created_at) VALUES (?,?,?,?,?)",
                    [user_id, mid, o.get("rating"), o.get("review"), o.get("created_at")])
                ok += 1
            except Exception as e:
                print("  ERR media", mid, e)
        print(f"\nAPPLIED {ok} ratings")
    else:
        print("\n(dry run - re-run with --apply to write)")


if __name__ == "__main__":
    main()
