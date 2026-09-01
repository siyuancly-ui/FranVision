#!/usr/bin/env python3
import json, sys

T = sys.argv[1] if len(sys.argv) > 1 else '3361'
d = json.load(open(f'parsed_{T}.json'))
colors = d['colors']; fonts = d['fonts']; stories = d['stories']; styles = d['styles']

def cname(ref):
    if not ref: return ''
    key = ref.split('/')[-1] if '/' in ref else ref
    c = colors.get(key) or colors.get(ref)
    if not c: return ref
    return f"{c.get('name')}={c.get('value')}"

def fname(ref):
    if not ref: return ''
    key = ref.split('/')[-1] if '/' in ref else ref
    f = fonts.get(key) or fonts.get(ref)
    return f"{f['family']}/{f['style']}" if f else ref

def stxt(ref, n=90):
    if not ref: return ''
    s = stories.get(ref) or stories.get(ref.split('/')[-1])
    if not s: return ''
    t = s['fullText'].replace('\n', ' | ').strip()
    return t[:n]

print(f"########## {T} ##########")
print("\n=== NAMED COLORS ===")
for k, v in colors.items():
    nm = v.get('name') or ''
    if nm and not nm.startswith('$') and v.get('value'):
        print(f"  {k:8} {nm:28} {v.get('space')}  {v.get('value')}")

for sp in d['spreads']:
    print(f"\n=== {sp['file']}  page {sp['pageW']}x{sp['pageH']}pt  ({len(sp['items'])} items) ===")
    rows = []
    for it in sp['items']:
        r = it.get('rect_norm')
        if not r:
            continue
        if r[2] < 0.015 or r[3] < 0.008:
            continue
        rows.append((r[1], r[0], it))
    rows.sort(key=lambda t: (t[0], t[1]))
    for _, _, it in rows:
        r = it['rect_norm']
        kind = it['tag']
        extra = ''
        if it.get('hasImage'):
            extra += f" IMG:{it['hasImage']}"
        if it.get('parentStory'):
            extra += f'  "{stxt(it["parentStory"])}"'
        fill = cname(it.get('fill'))
        strk = cname(it.get('stroke'))
        print(f"  {kind:9} x={r[0]:+.3f} y={r[1]:+.3f} w={r[2]:.3f} h={r[3]:.3f}  "
              f"fill=[{fill[:26]}] strk=[{strk[:18]}] sw={it.get('strokeWeight') or ''}{extra}")

print("\n=== STORIES (all text) ===")
for sid, s in stories.items():
    ft = s['fullText'].strip()
    if not ft:
        continue
    runs_info = []
    for run in s['runs']:
        if not run['text'].strip():
            continue
        runs_info.append(f"[{run.get('PointSize') or '?'}pt {fname(run.get('font'))} {cname(run.get('FillColor'))[:20]} trk={run.get('Tracking') or ''}]")
    print(f"  {sid}: \"{ft[:120].replace(chr(10),' | ')}\"")
    for ri in runs_info[:4]:
        print(f"       {ri}")
