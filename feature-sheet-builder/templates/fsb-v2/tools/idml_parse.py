#!/usr/bin/env python3
"""Extract geometry + text + styles from an unzipped IDML into JSON.

Usage: idml_parse.py <unzipped_idml_dir> [out.json]
"""
import sys, os, re, json, glob
import xml.etree.ElementTree as ET

DIR = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else None

def strip_ns(t):
    return t.split('}', 1)[1] if '}' in t else t

def parse(path):
    return ET.parse(path).getroot()

def mat_mul(m, n):
    a,b,c,d,e,f = m
    a2,b2,c2,d2,e2,f2 = n
    return (a*a2 + c*b2, b*a2 + d*b2,
            a*c2 + c*d2, b*c2 + d*d2,
            a*e2 + c*f2 + e, b*e2 + d*f2 + f)

def apply(m, x, y):
    a,b,c,d,e,f = m
    return (a*x + c*y + e, b*x + d*y + f)

def get_transform(el):
    t = el.get('ItemTransform')
    if not t:
        return (1,0,0,1,0,0)
    v = [float(k) for k in t.split()]
    return tuple(v)

# ---- colors ----
def load_colors():
    colors = {}
    g = os.path.join(DIR, 'Resources', 'Graphic.xml')
    if not os.path.exists(g):
        return colors
    root = parse(g)
    for el in root.iter():
        tag = strip_ns(el.tag)
        if tag in ('Color', 'Swatch', 'Tint', 'Gradient', 'MixedInk'):
            self_id = el.get('Self')
            colors[self_id] = {
                'tag': tag,
                'name': el.get('Name'),
                'space': el.get('Space'),
                'model': el.get('Model'),
                'value': el.get('ColorValue'),
            }
    return colors

# ---- fonts ----
def load_fonts():
    fonts = {}
    f = os.path.join(DIR, 'Resources', 'Fonts.xml')
    if not os.path.exists(f):
        return fonts
    root = parse(f)
    for el in root.iter():
        if strip_ns(el.tag) == 'Font':
            fonts[el.get('Self')] = {
                'family': el.get('FontFamily'),
                'style': el.get('FontStyleName'),
                'ps': el.get('PostScriptName'),
            }
    return fonts

# ---- paragraph / character styles ----
def load_styles():
    styles = {}
    s = os.path.join(DIR, 'Resources', 'Styles.xml')
    if not os.path.exists(s):
        return styles
    root = parse(s)
    for el in root.iter():
        tag = strip_ns(el.tag)
        if tag in ('ParagraphStyle', 'CharacterStyle'):
            props = {}
            for p in el:
                if strip_ns(p.tag) == 'Properties':
                    for pp in p:
                        props[strip_ns(pp.tag)] = (pp.text or '').strip()
            styles[el.get('Self')] = {
                'name': el.get('Name'),
                'PointSize': el.get('PointSize'),
                'Justification': el.get('Justification'),
                'FillColor': el.get('FillColor'),
                'Tracking': el.get('Tracking'),
                'AppliedFont': props.get('AppliedFont'),
                'Leading': None,
                'basedOn': props.get('BasedOn'),
            }
    return styles

# ---- stories (text content) ----
def load_stories():
    stories = {}
    for path in glob.glob(os.path.join(DIR, 'Stories', 'Story_*.xml')):
        root = parse(path)
        for st in root.iter():
            if strip_ns(st.tag) != 'Story':
                continue
            sid = st.get('Self')
            runs = []
            for csr in st.iter():
                if strip_ns(csr.tag) != 'CharacterStyleRange':
                    continue
                txt = ''
                for c in csr.iter():
                    if strip_ns(c.tag) == 'Content':
                        txt += (c.text or '')
                    elif strip_ns(c.tag) == 'Br':
                        txt += '\n'
                pointsize = csr.get('PointSize')
                font_ref = None
                fill = csr.get('FillColor')
                tracking = csr.get('Tracking')
                for p in csr:
                    if strip_ns(p.tag) == 'Properties':
                        for pp in p:
                            if strip_ns(pp.tag) == 'AppliedFont':
                                font_ref = (pp.text or '').strip()
                            if strip_ns(pp.tag) == 'Leading':
                                pass
                runs.append({
                    'text': txt,
                    'PointSize': pointsize,
                    'font': font_ref,
                    'FillColor': fill,
                    'Tracking': tracking,
                    'charStyle': csr.get('AppliedCharacterStyle'),
                })
            # paragraph styles used
            para_styles = []
            for psr in st.iter():
                if strip_ns(psr.tag) == 'ParagraphStyleRange':
                    para_styles.append({
                        'style': psr.get('AppliedParagraphStyle'),
                        'Justification': psr.get('Justification'),
                        'PointSize': psr.get('PointSize'),
                    })
            stories[sid] = {'runs': runs, 'paraStyles': para_styles,
                            'fullText': ''.join(r['text'] for r in runs)}
    return stories

# ---- geometry: bbox of a path-bearing element in its own coords ----
def local_bbox(el):
    xs, ys = [], []
    for gp in el.iter():
        if strip_ns(gp.tag) != 'PathPointType':
            continue
        anch = gp.get('Anchor')
        if anch:
            x, y = [float(v) for v in anch.split()]
            xs.append(x); ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))

ITEM_TAGS = {'Rectangle', 'Polygon', 'Oval', 'GraphicLine', 'TextFrame', 'Group'}

def walk(el, parent_mat, page_items, depth=0):
    tag = strip_ns(el.tag)
    if tag in ITEM_TAGS:
        m = mat_mul(parent_mat, get_transform(el))
        bb = local_bbox(el)
        rec = {
            'tag': tag,
            'self': el.get('Self'),
            'name': el.get('Name') or el.get('Label'),
            'mat': m,
        }
        if bb:
            corners = [apply(m, bb[0], bb[1]), apply(m, bb[2], bb[1]),
                       apply(m, bb[2], bb[3]), apply(m, bb[0], bb[3])]
            xs = [c[0] for c in corners]; ys = [c[1] for c in corners]
            rec['bbox_spread'] = (min(xs), min(ys), max(xs), max(ys))
        rec['contentType'] = el.get('ContentType')
        rec['fill'] = el.get('FillColor')
        rec['stroke'] = el.get('StrokeColor')
        rec['strokeWeight'] = el.get('StrokeWeight')
        if tag == 'TextFrame':
            rec['parentStory'] = el.get('ParentStory')
        # image inside?
        for ch in el:
            if strip_ns(ch.tag) in ('Image', 'EPS', 'PDF', 'WMF'):
                rec['hasImage'] = strip_ns(ch.tag)
                for gb in ch:
                    if strip_ns(gb.tag) == 'GraphicBounds':
                        pass
                lnk = ch.find('.//{*}Link')
                if lnk is not None:
                    rec['linkURI'] = lnk.get('LinkResourceURI')
        page_items.append(rec)
        if tag == 'Group':
            for ch in el:
                walk(ch, m, page_items, depth+1)
        return
    for ch in el:
        walk(ch, parent_mat, page_items, depth)

def load_spreads():
    dm = parse(os.path.join(DIR, 'designmap.xml'))
    order = []
    for el in dm.iter():
        if strip_ns(el.tag) == 'Spread':
            src = el.get('src')
            if src:
                order.append(os.path.basename(src))
    result = []
    for fn in order:
        path = os.path.join(DIR, 'Spreads', fn)
        if not os.path.exists(path):
            continue
        root = parse(path)
        # the real <Spread> element carries a Self starting with the spread id;
        # the idPkg wrapper root also matches strip_ns=='Spread'. Take children.
        spreads = [c for c in root if strip_ns(c.tag) == 'Spread']
        for sp in spreads:
            sp_mat = get_transform(sp)
            pages = []
            for pg in sp:
                if strip_ns(pg.tag) == 'Page':
                    gb = pg.get('GeometricBounds')
                    pm = mat_mul(sp_mat, get_transform(pg))
                    b = [float(v) for v in gb.split()] if gb else None
                    # page-local width/height from bounds [y1 x1 y2 x2]
                    w = (b[3] - b[1]) if b else None
                    h = (b[2] - b[0]) if b else None
                    pages.append({'self': pg.get('Self'), 'geoBounds': b,
                                  'mat': pm, 'w': w, 'h': h, 'name': pg.get('Name')})
            items = []
            for ch in sp:
                walk(ch, sp_mat, items, 0)
            # normalize each item bbox against the (single) page
            if pages and pages[0]['w']:
                pg = pages[0]
                m = pg['mat']  # page-local -> spread
                inv_e, inv_f = -m[4], -m[5]   # assume no rotation/scale on page
                for it in items:
                    bb = it.get('bbox_spread')
                    if not bb:
                        continue
                    x1 = bb[0] + inv_e; y1 = bb[1] + inv_f
                    x2 = bb[2] + inv_e; y2 = bb[3] + inv_f
                    it['bbox_page_pt'] = (round(x1,2), round(y1,2), round(x2,2), round(y2,2))
                    it['rect_norm'] = (round(x1/pg['w'],5), round(y1/pg['h'],5),
                                       round((x2-x1)/pg['w'],5), round((y2-y1)/pg['h'],5))
            result.append({'file': fn, 'spreadSelf': sp.get('Self'),
                           'pageW': pages[0]['w'] if pages else None,
                           'pageH': pages[0]['h'] if pages else None,
                           'pages': pages, 'items': items})
    return result

data = {
    'dir': DIR,
    'colors': load_colors(),
    'fonts': load_fonts(),
    'styles': load_styles(),
    'stories': load_stories(),
    'spreads': load_spreads(),
}

out = json.dumps(data, indent=1, ensure_ascii=False, default=str)
if OUT:
    open(OUT, 'w').write(out)
    print('wrote', OUT, len(out), 'bytes')
else:
    print(out)
