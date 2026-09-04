# -*- coding: utf-8 -*-
"""tools/build-avg-effects.py —— 从游戏 bundle 生成 AVG 特效的浏览器可消费件。

取代 data/index/avg-effects.json 里手写的三条条目（FXP_smook / FXP_AVG_Hit-knife /
FXP_AVG_snow_high），并把普查出来的其余真粒子特效补齐。清单来源：
  node tools/audit-effects.mjs --prefab     # 全语料 effect1..4[].prefabName

取件姿势与 build-hero-layouts.py 同源：bundle 有 FakeHeader 前缀填充，切到真
UnityFS 签名再喂 UnityPy；跨包引用（贴图常在别的 .ab）按 external_references
解析，不靠猜文件名。

用法：
  python tools/build-avg-effects.py                       # 干跑，打印每件读到的真值
  python tools/build-avg-effects.py --write               # 落 data/effects/ 与索引
  python tools/build-avg-effects.py --only avg/FXP_Scene  # 只做一件
"""
import argparse
import json
import os
import re
import sys

import UnityPy

# Windows 控制台默认 GBK，重定向到文件会写成乱码；报告统一按 UTF-8 出。
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BUNDLES = r'C:\Users\Administrator\Documents\MuMu共享文件夹\bundles'
PREFAB_DIRS = ('res/effect/prefabs/avg', 'fx/scene/am_smook', 'fx/ui_effct/avgeffect')
OUT_INDEX = os.path.join(ROOT, 'data', 'index', 'avg-effects.json')
OUT_TEX = os.path.join(ROOT, 'data', 'effects')

# Unity UnityEngine.Rendering.BlendMode
BLEND = {0: 'zero', 1: 'one', 2: 'dstColor', 3: 'srcColor', 4: 'oneMinusDstColor',
         5: 'oneMinusSrcColor', 6: 'dstAlpha', 7: 'srcAlpha', 8: 'oneMinusDstAlpha',
         9: 'oneMinusSrcAlpha'}
# (src, dst) → CSS mix-blend-mode。additive 用 screen 而不是 plus-lighter：
# 与既有手写件同口径，且在 UI 上两者观感差远小于「乘错」的风险。
CSS_BLEND = {(7, 9): 'normal', (7, 1): 'screen', (3, 0): 'multiply',
             (6, 9): 'normal', (1, 0): 'screen', (2, 0): 'multiply',
             (1, 9): 'lighten'}


_ENV_CACHE = {}
_CAB_INDEX = None
# 特效的材质/贴图常不在预制件自己包里（依赖按 CAB 哈希引用），扫描范围限这几处。
CAB_DIRS = ('res/effect', 'fx/ui_effct', 'fx/role', 'fx/scene', 'built-in-res')


def strip_bundle(path):
    raw = open(path, 'rb').read()
    i = raw.find(b'UnityFS')                 # FakeHeader：真签名前有填充字节
    return raw[i:] if i > 0 else raw


def load_env(path):
    if path not in _ENV_CACHE:
        _ENV_CACHE[path] = UnityPy.load(strip_bundle(path))
    return _ENV_CACHE[path]

def field(obj, name, default=None):
    return getattr(obj, name, default)


def curve_scalar(mc, default=0.0):
    """MinMaxCurve → 代表值（常量取 scalar，曲线取 keys 的最大值）。"""
    if mc is None:
        return default
    state = field(mc, 'minMaxState', 0)
    scalar = field(mc, 'scalar', 1.0)
    if state == 0:
        return float(scalar)
    if state == 2:                       # 两常量之间
        return (float(scalar) + float(field(mc, 'minScalar', scalar))) / 2.0
    for key in ('maxCurve', 'minCurve'):
        curve = getattr(mc, key, None)
        if curve is None:
            continue
        keys = getattr(curve, 'm_Curve', None) or []
        if keys:
            vals = [float(getattr(k, 'value', 0.0)) for k in keys if hasattr(k, 'value')]
            if vals:
                return max(vals) * float(scalar or 1.0)
    return float(scalar)


GRAD_KEYS = tuple('key%d' % i for i in range(8))


def gradient_stops(grad):
    """UnityPy Gradient → [(时间 0..1, [r,g,b,a])]，按实测结构 key0..7 + atime0..6。"""
    if grad is None:
        return []
    n = int(getattr(grad, 'm_NumColorKeys', 0) or 0)
    out = []
    for i in range(min(n, 8)):
        c = getattr(grad, GRAD_KEYS[i], None)
        if c is None:
            continue
        t = float(getattr(grad, 'atime%d' % i, 0) or 0) / 65535.0
        out.append((round(t, 4), color_of(c)))
    return sorted(out, key=lambda x: x[0])


def minmax_color(mg):
    """MinMaxGradient → 代表 RGBA（常量色直接取，渐变取首键）。"""
    if mg is None:
        return None
    state = int(field(mg, 'minMaxState', 0) or 0)
    mc = getattr(mg, 'maxColor', None)
    if state == 0 and mc is not None:
        return color_of(mc)
    stops = gradient_stops(getattr(mg, 'maxGradient', None))
    return stops[0][1] if stops else color_of(mc)


def gradient_peak_alpha(grad_or_mg):
    """MinMaxGradient/Gradient → 峰值 alpha（0..1）。"""
    if grad_or_mg is None:
        return None
    grad = getattr(grad_or_mg, 'maxGradient', None)
    if grad is not None and gradient_stops(grad):
        return max(c[3] for _, c in gradient_stops(grad))
    mc = getattr(grad_or_mg, 'maxColor', None)
    if mc is not None:
        return float(getattr(mc, 'a', 1.0))
    stops = gradient_stops(grad_or_mg)
    return max((c[3] for _, c in stops), default=None)


def color_of(rgba):
    if rgba is None:
        return None
    return [float(getattr(rgba, a, 0.0)) for a in ('r', 'g', 'b', 'a')]


def vec3(v):
    """UnityPy Vector3f（不可迭代）→ [x, y, z]。"""
    if v is None:
        return [0.0, 0.0, 0.0]
    return [float(getattr(v, 'x', 0.0) or 0.0), float(getattr(v, 'y', 0.0) or 0.0),
            float(getattr(v, 'z', 0.0) or 0.0)]


def quat(q):
    if q is None:
        return [0.0, 0.0, 0.0, 1.0]
    xyz = [float(getattr(q, a, 0.0) or 0.0) for a in ('x', 'y', 'z')]
    return xyz + [float(getattr(q, 'w', 1.0) or 1.0)]


def cab_index(bundles_root):
    """cab 名 → .ab 路径。依赖是按 CAB 哈希引用的，这张表只能自己建。"""
    global _CAB_INDEX
    if _CAB_INDEX is None:
        _CAB_INDEX = {}
        for rel in CAB_DIRS:
            d = os.path.join(bundles_root, rel.replace('/', os.sep))
            if not os.path.isdir(d):
                continue
            for dirpath, _, files in os.walk(d):
                for fn in files:
                    if not fn.endswith('.ab'):
                        continue
                    p = os.path.join(dirpath, fn)
                    try:
                        env = load_env(p)
                    except Exception:
                        continue
                    for nm in (getattr(env.file, 'files', {}) or {}):
                        _CAB_INDEX.setdefault(nm, p)
    return _CAB_INDEX


def external_cab(sf, file_id):
    """m_FileID 是 1 基（0 = 本文件），故取 externals[file_id - 1]；
    条目形如 archive:/CAB-x/CAB-x，取末段 cab 名。"""
    if not file_id:
        return None
    try:
        e = sf.externals[file_id - 1]
    except Exception:
        return None
    path = getattr(e, 'path', None) or str(e)
    parts = [p for p in path.split('/') if p.startswith('CAB-')]
    return parts[-1] if parts else None


def resolve_pptr(pptr, bundles_root):
    """PPtr → 对象；同包直接 deref，跨包按 cab 索引找回源包。"""
    if pptr is None or not getattr(pptr, 'm_PathID', 0):
        return None
    if not getattr(pptr, 'm_FileID', 0):
        try:
            return pptr.read()
        except Exception:
            return None
    cab = external_cab(getattr(pptr, 'assetsfile', None), pptr.m_FileID)
    path = cab_index(bundles_root).get(cab) if cab else None
    if not path:
        return None
    try:
        env = load_env(path)
    except Exception:
        return None
    for o in env.objects:
        if o.path_id == pptr.m_PathID:
            try:
                return o.read()
            except Exception:
                return None
    return None


def resolve_src(pptr, bundles_root, home_path):
    """PPtr 所属 .ab 的相对路径（索引里写 sourceBundle / dependencies 用）。"""
    if pptr is None:
        return None
    if not getattr(pptr, 'm_FileID', 0):
        return os.path.relpath(home_path, bundles_root).replace('\\', '/')
    cab = external_cab(getattr(pptr, 'assetsfile', None), pptr.m_FileID)
    path = cab_index(bundles_root).get(cab) if cab else None
    return os.path.relpath(path, bundles_root).replace('\\', '/') if path else None

def _sheet_entries(sheet, slot):
    """UnityPropertySheet 的某个桶 → [(名字, 值)]。新版是 dict，旧版是 pair 列表。"""
    raw = getattr(sheet, slot, None)
    if raw is None:
        return []
    if isinstance(raw, dict):
        return [(str(k), v) for k, v in raw.items()]
    out = []
    for item in raw:
        name = getattr(item, 'first', None)
        if name is None and isinstance(item, (list, tuple)) and len(item) == 2:
            name, val = item
        elif name is not None:
            val = getattr(item, 'second', None)
        else:
            continue
        out.append((str(name), val))
    return out


def material_facts(mat, resolve=None):
    """Material → 主贴图 PPtr、混合模式、tint、shader 名。"""
    if mat is None:
        return None
    saved = getattr(mat, 'm_SavedProperties', None)
    texes = dict(_sheet_entries(saved, 'm_TexEnvs')) if saved is not None else {}
    floats = dict(_sheet_entries(saved, 'm_Floats')) if saved is not None else {}
    colors = dict(_sheet_entries(saved, 'm_Colors')) if saved is not None else {}
    tex_pptr = None
    tex_slot = ''
    # 优先认常见槽名；云图特效材质大量用 _NoiseTex/_Tex01 这类自定义槽位，
    # 只按固定名找会解出空贴图（FXM_ckui_33、FXP_UltimateSkill_Florence_05）。
    preferred = ('_MainTex', '_BaseMap', '_BaseTex', '_Maintexture')
    for key, t in texes.items():
        inner = getattr(t, 'm_Texture', None) if t is not None else None
        if inner is None or not getattr(inner, 'm_PathID', 0):
            continue
        if tex_pptr is None or key in preferred:
            tex_pptr, tex_slot = inner, key
        if key in preferred:
            break
    def num(*keys):
        for k in keys:
            v = floats.get(k)
            if v is not None:
                try:
                    return int(float(v))
                except (TypeError, ValueError):
                    pass
        return 0
    src, dst = num('_SrcBlend', '_BlendOpSrc'), num('_DstBlend', '_BlendOpDst')
    blend = CSS_BLEND.get((src, dst), 'screen')
    shader_name = ''
    if resolve is not None:
        sh = resolve(getattr(mat, 'm_Shader', None))
        shader_name = getattr(sh, 'm_Name', '') or '' if sh is not None else ''
    return {'shader': shader_name, 'texture_pptr': tex_pptr, 'texture_slot': tex_slot,
            'blend': blend,
            'tint': colors.get('_TintColor') or colors.get('_Color'),
            'src': src, 'dst': dst,
            'floats': {k: float(v) for k, v in floats.items()
                       if isinstance(v, (int, float))}}


def collect_prefabs(bundles_root):
    """root GameObject 名（小写） → .ab 路径。"""
    out = {}
    for rel in PREFAB_DIRS:
        d = os.path.join(bundles_root, rel.replace('/', os.sep))
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.ab'):
                continue
            path = os.path.join(d, fn)
            try:
                env = load_env(path)
            except Exception:
                continue
            names = []
            for o in env.objects:
                if o.type.name == 'GameObject':
                    go = o.read()
                    tr = None
                    for comp in (go.m_Component or []):
                        obj = None
                        try:
                            obj = comp.component.read()
                        except Exception:
                            continue
                        if obj is not None and type(obj).__name__ in ('Transform', 'RectTransform'):
                            tr = obj
                            break
                    if tr is not None and not getattr(tr, 'm_Father', None) or \
                            (tr is not None and not getattr(getattr(tr, 'm_Father', None), 'm_PathID', 0)):
                        names.append(go.m_Name)
            for n in names:
                out.setdefault(n.lower(), (path, n))
    return out


def ps_parts(path, prefab_name, bundles_root, write):
    """一个 .ab → 该特效的 parts / 单件字段列表。"""
    env = load_env(path)
    transforms = {}
    for o in env.objects:
        if o.type.name in ('Transform', 'RectTransform'):
            transforms[o.path_id] = o.read()

    def lossy_scale_x(tr):
        """祖先链 localScale.x 累乘；根节点在 bundle 里写 0（运行时才填）按 1 处理。"""
        total, cur, seen = 1.0, tr, set()
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            s = float(getattr(cur.m_LocalScale, 'x', 1.0) or 0.0)
            total *= s if s else 1.0
            f = getattr(cur, 'm_Father', None)
            cur = transforms.get(f.m_PathID) if f and f.m_PathID else None
        return total

    results = []
    for o in env.objects:
        if o.type.name != 'ParticleSystemRenderer':
            continue
        psr = o.read()
        go = psr.m_GameObject.read() if psr.m_GameObject else None
        node = go.m_Name if go else '?'
        ps = None
        for comp in (go.m_Component or []):
            obj = comp.component.read()
            if type(obj).__name__ == 'ParticleSystem':
                ps = obj
                break
        if ps is None:
            continue
        mats = getattr(psr, 'm_Materials', None) or []
        mat_pptr = mats[0] if mats else None
        mat_obj = resolve_pptr(mat_pptr, bundles_root) if mat_pptr else None
        mfacts = material_facts(mat_obj,
            resolve=lambda pp: resolve_pptr(pp, bundles_root))
        tex = None
        if mfacts and mfacts['texture_pptr'] is not None:
            tex = resolve_pptr(mfacts['texture_pptr'], bundles_root)
        uv = getattr(ps, 'UVModule', None)
        init = getattr(ps, 'InitialModule', None)
        size_mod = getattr(ps, 'SizeModule', None)
        sbs_mod = getattr(ps, 'SizeBySpeedModule', None)
        vel_mod = getattr(ps, 'VelocityModule', None)
        shape = getattr(ps, 'ShapeModule', None)
        shape_on = bool(getattr(shape, 'enabled', False)) if shape is not None else False
        shape_radius = float(getattr(getattr(shape, 'radius', None), 'value', 0.0) or 0.0) \
            if shape_on else 0.0
        main = {'loop': bool(getattr(ps, 'looping', False)),
                'length': float(getattr(ps, 'lengthInSec', 1.0) or 1.0),
                'lifetime': curve_scalar(getattr(init, 'startLifetime', None), 1.0)
                if init else 1.0,
                'maxParticles': int(getattr(init, 'maxNumParticles', 0) or 0) if init else 0,
                'startColor': minmax_color(getattr(init, 'startColor', None)) if init else None}
        tiles_x = int(getattr(uv, 'tilesX', 1) or 1) if uv else 1
        tiles_y = int(getattr(uv, 'tilesY', 1) or 1) if uv else 1
        frames = int(tiles_x * tiles_y) if (uv and getattr(uv, 'enabled', False)) else 1
        col = getattr(ps, 'ColorModule', None)
        alpha = None
        if col is not None and getattr(col, 'enabled', False):
            alpha = gradient_peak_alpha(getattr(col, 'gradient', None))
        tr = None
        for comp in (go.m_Component or []):
            obj = comp.component.read()
            if type(obj).__name__ in ('Transform', 'RectTransform'):
                tr = obj
                break
        pos = vec3(getattr(tr, 'm_LocalPosition', None)) if tr else [0.0, 0.0, 0.0]
        rot = quat(getattr(tr, 'm_LocalRotation', None)) if tr else [0.0, 0.0, 0.0, 1.0]
        scl = vec3(getattr(tr, 'm_LocalScale', None)) if tr else [1.0, 1.0, 1.0]
        results.append({
            'node': node, 'prefab': prefab_name,
            'texBundle': resolve_src(mfacts['texture_pptr'], bundles_root, path) if mfacts else None,
            'material': getattr(mat_obj, 'm_Name', '') if mat_obj else '',
            'shader': mfacts['shader'] if mfacts else '',
            'blend': mfacts['blend'] if mfacts else 'screen',
            'srcBlend': mfacts['src'] if mfacts else 0,
            'dstBlend': mfacts['dst'] if mfacts else 0,
            'tint': color_of(mfacts['tint']) if mfacts else None,
            'texture': getattr(tex, 'm_Name', '') if tex else '',
            'texSlot': mfacts['texture_slot'] if mfacts else '',
            'texW': int(getattr(tex, 'm_Width', 0) or 0) if tex else 0,
            'texH': int(getattr(tex, 'm_Height', 0) or 0) if tex else 0,
            'texObj': tex,
            'columns': tiles_x, 'rows': tiles_y, 'frames': frames,
            'uvFps': float(getattr(uv, 'fps', 0) or 0) if uv else 0.0,
            'uvCycles': float(getattr(uv, 'cycles', 1) or 1) if uv else 1.0,
            'uvRowMode': int(getattr(uv, 'rowMode', 0) or 0) if uv else 0,
            'loop': main['loop'], 'length': main['length'],
            'lifetime': main['lifetime'], 'maxParticles': main['maxParticles'],
            'startColor': main['startColor'],
            'startSize': curve_scalar(getattr(init, 'startSize', None), 1.0) if init else 1.0,
            'startSpeed': curve_scalar(getattr(init, 'startSpeed', None), 0.0) if init else 0.0,
            'gravity': curve_scalar(getattr(init, 'gravityModifier', None), 0.0) if init else 0.0,
            'velocityX': curve_scalar(getattr(vel_mod, 'x', None), 0.0)
                         if vel_mod is not None and getattr(vel_mod, 'enabled', False) else 0.0,
            'sizeOver': curve_scalar(getattr(size_mod, 'curve', None), 1.0)
                        if size_mod is not None and getattr(size_mod, 'enabled', False) else 1.0,
            'sizeBySpeed': curve_scalar(getattr(sbs_mod, 'x', None), 1.0)
                           if sbs_mod is not None and getattr(sbs_mod, 'enabled', False) else 1.0,
            'shapeRadius': shape_radius,
            'gradientAlpha': alpha,
            'pos': [round(float(x), 3) for x in pos],
            'scale': [round(float(x), 3) for x in scl],
            'lossyScale': round(lossy_scale_x(tr), 4) if tr else 1.0,
            'scalingMode': int(getattr(ps, 'scalingMode', 0) or 0),
            'rotQ': [round(float(x), 4) for x in rot],
            'renderMode': int(getattr(psr, 'm_RenderMode', 0) or 0),
            'bundle': path,
        })
    return results


def z_rotation_from_q(q):
    """四元数 (x,y,z,w) → 平面内 z 角度（度）。"""
    x, y, z, w = q
    import math
    return round(math.degrees(math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))), 2)


def slug(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name or '')


def quad_size(p):
    """一个粒子 quad 的边长（预制件自身单位，正方形：全语料 startSize3D 都是 false）。

    缩放按 Unity 的 ParticleSystemScalingMode 取：Local(1) 只认系统自己的
    localScale（父级缩放无效），Hierarchy(0)/Shape(2) 要乘整条 lossyScale——
    FXP_AVG_snow_high 的 20.153 就挂在根上，只按节点自身 scale 算会把一场雪缩成 2px。
    边长本身是「单粒 + 发射口径 2×radius + 寿命内行程」相加——浏览器里一件只画一个
    quad，这个盒子要盖住粒子能到达的范围，只按单粒画会缩成一个点、只按粒子尺寸算
    会把一场雪糊成一团。
    """
    scl = float(p['scale'][0]) if p['scalingMode'] == 1 else float(p['lossyScale'])
    life = p['lifetime']
    # 粒子活着这段时间能飘多远：初速 + VelocityModule 附加 + ½·g·t²（本地单位）。
    travel = (abs(p['startSpeed']) + abs(p['velocityX'])) * life \
        + 0.5 * abs(p['gravity']) * life * life
    local = (p['startSize'] * p['sizeOver'] * p['sizeBySpeed']
             + 2.0 * p['shapeRadius'] + travel)
    return round(local * scl, 3)


# css/ux.css 用 .blade / .spark 挂刀光与火花的 keyframes（动画名与延时都按件区分），
# 那是 CSS 契约而不是 bundle 里的名字，所以只能在这张表里显式对。其余件按节点名生成。
CLASS_BY_TEXTURE = {'FXT_HIT4': 'blade', 'FXT_Sparks016': 'spark'}


def part_class(p):
    return CLASS_BY_TEXTURE.get(p['texture']) or slug(p['node']).replace('.', '-').lower()


def tint_of(p):
    """粒子色 = texture × startColor。纯白等价于不染色，返回 None 省掉 mask。"""
    sc = p['startColor']
    if not sc:
        return None
    rgb = tuple(int(round(c * 255)) for c in sc[:3])
    if rgb == (255, 255, 255):
        return None
    return 'rgb(%d, %d, %d)' % rgb


def mask_mode_of(p):
    """alpha 通道全平的贴图（黑底发光图）在 Unity 里按亮度相乘，
    CSS mask 默认按 alpha 剪形会剪出满矩形 ⇒ 必须 luminance。"""
    tex = p.get('texObj')
    if tex is None:
        return None
    try:
        img = tex.image
        if img is None or 'A' not in img.getbands():
            return 'luminance'
        lo, hi = img.getchannel('A').getextrema()
    except Exception:
        return None
    return 'luminance' if lo == hi else None


def emit_entry(key, parts, bundles_root, write):
    """一个特效的粒子件 → 索引条目；贴图按需落 data/effects/。

    单贴图 → 序列帧形式（player 走 background-position 逐帧）；
    多贴图 → parts[]（每件一个 span，各自 url/旋转/不透明度）。
    """
    with_tex = [p for p in parts if p['texture']]
    if not with_tex:
        return None
    uniq = []
    for p in with_tex:
        if p['texture'] not in [u['texture'] for u in uniq]:
            uniq.append(p)

    def opacity_of(p):
        a = p['gradientAlpha'] if p['gradientAlpha'] is not None else 1.0
        if p['startColor']:
            a *= p['startColor'][3]
        return round(min(1.0, max(0.0, a)), 3)

    def url_of(p):
        rel = 'data/effects/%s.png' % slug(p['texture'])
        if write and p['texObj'] is not None:
            os.makedirs(OUT_TEX, exist_ok=True)
            dst = os.path.join(ROOT, *rel.split('/'))
            if not os.path.exists(dst):
                try:
                    p['texObj'].image.save(dst)
                except Exception as e:
                    print('   ! 贴图导出失败 %s: %s' % (p['texture'], e), file=sys.stderr)
        return rel

    duration = int(round(max(p['length'] for p in parts) * 1000))
    loop = any(p['loop'] for p in parts)
    # UVModule 关掉时 tilesX/tilesY 只是残留值，不是格子数：按它裁图会把整张
    # 贴图切成左上格放大（实测 Hit_yellow 满屏一个色块）。单帧一律 1×1。
    grid = (lambda p: (p['columns'], p['rows']) if p['frames'] > 1 else (1, 1))
    blend = uniq[0]['blend']
    src = os.path.relpath(uniq[0]['bundle'], bundles_root).replace('\\', '/')
    deps = sorted({os.path.relpath(p['bundle'], bundles_root).replace('\\', '/')
                   for p in uniq if p['bundle']} - {src})
    if len(uniq) == 1:
        p = uniq[0]
        cols, rows = grid(p)
        return {'url': url_of(p), 'columns': cols, 'rows': rows,
                'frames': max(1, p['frames']),
                'fps': p['uvFps'] or None, 'duration': duration, 'loop': loop,
                'size': quad_size(p), 'life': int(round(p['lifetime'] * 1000)),
                'opacity': opacity_of(p), 'blendMode': blend,
                'tint': tint_of(p), 'maskMode': mask_mode_of(p),
                'textureSlot': p['texSlot'] or None, 'sourceBundle': src,
                'nodes': len(parts)}
    return {'parts': [{'url': url_of(p), 'className': part_class(p),
                       'opacity': opacity_of(p), 'tint': tint_of(p),
                       'maskMode': mask_mode_of(p),
                       'columns': grid(p)[0], 'rows': grid(p)[1],
                       'frames': max(1, p['frames']),
                       'size': quad_size(p),
                       'duration': int(round(p['length'] * 1000)),
                       'life': int(round(p['lifetime'] * 1000)),
                       'rotate': z_rotation_from_q(p['rotQ'])}
                      for p in uniq],
            'duration': duration, 'loop': loop, 'blendMode': blend,
            'sourceBundle': src, 'dependencies': deps, 'nodes': len(parts)}


def main():
    ap = argparse.ArgumentParser(description='生成 AVG 特效的浏览器可消费件')
    ap.add_argument('--write', action='store_true', help='落盘 data/effects/ 与索引')
    ap.add_argument('--bundle-root', default=DEFAULT_BUNDLES)
    ap.add_argument('--only', action='append', default=[],
                    help='只做指定 prefab（可重复），如 --only avg/FXP_Scene')
    ap.add_argument('--existing', default=OUT_INDEX, help='要合并/覆盖的既有索引')
    args = ap.parse_args()

    wanted = ['avg/FXP_smook', 'avg/FXP_Scene', 'avg/FXP_AVG_Hit-knife',
              'avg/FXP_AVG_snow_high', 'avg/FXP_AVG_Hit-knife-blue',
              'avg/FXP_AVG_Hit_yellow']
    if args.only:
        wanted = args.only

    print('扫描 bundle …', file=sys.stderr)
    index = collect_prefabs(args.bundle_root)
    existing = {}
    if os.path.exists(args.existing):
        existing = json.load(open(args.existing, encoding='utf-8'))

    out = dict(existing)
    report = []
    for key in wanted:
        name = key.rsplit('/', 1)[-1]
        hit = index.get(name.lower())
        if not hit:
            report.append((key, None, 'bundle 里找不到同名 root'))
            continue
        path, prefab_name = hit
        parts = ps_parts(path, prefab_name, args.bundle_root, args.write)
        report.append((key, (path, prefab_name), parts))

    for key, hit, parts in report:
        if not hit:
            print('')
            print('### %s  ✗ %s' % (key, parts))
            continue
        path, prefab_name = hit
        if parts is None:
            continue
        print('')
        print('### %s   root=%s   %d 个粒子渲染器' % (key, prefab_name, len(parts)))
        entry = emit_entry(key, parts, args.bundle_root, args.write)
        if entry:
            out[key] = entry
        for p in parts:
            print('  · node=%-22s mat=%-26s tex=%-22s %dx%d  tiles=%dx%d frames=%d'
                  % (p['node'], p['material'], p['texture'], p['texW'], p['texH'],
                     p['columns'], p['rows'], p['frames']))
            print('      loop=%s len=%.2fs life=%.2fs fps=%.0f cycles=%.2f rowMode=%d'
                  ' blend=%s(%d,%d) gradA=%s startColor=%s max=%d'
                  % (p['loop'], p['length'], p['lifetime'], p['uvFps'], p['uvCycles'],
                     p['uvRowMode'], p['blend'], p['srcBlend'], p['dstBlend'],
                     p['gradientAlpha'], p['startColor'], p['maxParticles']))
            print('      pos=%s scale=%s rotZ=%.1f° renderMode=%d quad=%s 贴图包=%s'
                  % (p['pos'], p['scale'], z_rotation_from_q(p['rotQ']),
                     p['renderMode'], quad_size(p), p['texBundle'] or '(未解析)'))
            if p['texSlot']:
                print('      槽=%s 材质槽解析: %s' % (p['texSlot'], p['texture']))
    if args.write:
        os.makedirs(OUT_TEX, exist_ok=True)
        with open(OUT_INDEX, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(out, ensure_ascii=False, indent=2))
            fh.write(chr(10))
        print('写出 %s：%d 件' % (OUT_INDEX, len(out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
