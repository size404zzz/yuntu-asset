# -*- coding: utf-8 -*-
"""tools/build-hero-layouts.py —— 从游戏 bundle 生成全部剧情立绘的 layout 件。

取代两样东西：
  1. `data/layouts/*.json` 的人眼标定（editor 的 layout-cal，此前只有 3 份）；
  2. `js/engine/sprite.js` 里对缺件角色「按 lpic 不透明高度反解 m_LocalScale」的启发式。

真源两处（P0-1 实测，2026-08-31）：
  · 立绘 prefab 根 RectTransform：m_LocalScale.x → m_LocalScale（**带符号 = 镜像**，
    croque 是 -1.9）、m_SizeDelta.x → sizeDelta；
  · 同 GameObject 上的 MonoBehaviour CommonPicController：posData[] 里
    AvgHero1..5 的 pos/scale/alpha，加 avgCommPos/avgCommScale/avgFaceSize/avgFacePos。
  两份对 sol/croque/persicaria 与既有人工标定件逐格一致。

用 UnityPy 而不是 AssetStudio：AssetStudio 只 Dump MonoBehaviour（读不到 RectTransform），
且同 bundle 内多个同名 MonoBehaviour 会抢写同一个文件、落盘哪份是随机的。

用法：
  python tools/build-hero-layouts.py                # 干跑，只出对比报告
  python tools/build-hero-layouts.py --write        # 落 data/layouts/（已存在且不同则报冲突）
  python tools/build-hero-layouts.py --bundle-root <dir>
"""
import argparse
import json
import os
import sys

import UnityPy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BUNDLES = r'C:\Users\Administrator\Documents\MuMu共享文件夹\bundles'
SLOTS = ('AvgHero1', 'AvgHero2', 'AvgHero3', 'AvgHero4', 'AvgHero5')


def load_env(path):
    raw = open(path, 'rb').read()
    i = raw.find(b'UnityFS')                 # FakeHeader：签名前有填充字节
    return UnityPy.load(raw[i:] if i > 0 else raw)


def hero_layout(bundle):
    """lpic_<hero>.ab → (layout dict | None, 说明)"""
    env = load_env(bundle)
    rt, pic, has_l2d = None, None, False
    for o in env.objects:
        tn = getattr(o.type, 'name', str(o.type))
        if tn == 'RectTransform':
            try:
                r = o.read()
                if rt is None or getattr(r, 'm_LocalScale', None) is not None:
                    rt = r
            except Exception:               # noqa: BLE001
                pass
        elif tn == 'MonoBehaviour':
            try:
                d = o.read()
            except Exception:               # noqa: BLE001
                continue
            if hasattr(d, 'posData'):
                pic = d
            if type(d).__name__.startswith('Cubism'):
                has_l2d = True
    if pic is None or rt is None:
        return None, ('无 CommonPicController' if pic is None else '无 RectTransform')

    lay = {'sizeDelta': round(float(rt.m_SizeDelta.x), 4),
           'm_LocalScale': round(float(rt.m_LocalScale.x), 4)}
    for e in pic.posData:
        nm = _f(e, 'name')
        if nm not in SLOTS:
            continue
        pos, sc = _f(e, 'pos'), _f(e, 'scale')
        lay[nm] = {'pos': [round(float(pos.x), 4), round(float(pos.y), 4)],
                   'scale': [round(float(sc.x), 4), round(float(sc.y), 4)],
                   'alpha': round(float(_f(e, 'alpha')), 4)}
    for k in ('avgCommPos', 'avgFacePos'):
        v = _f(pic, k)
        lay[k] = [round(float(v.x), 4), round(float(v.y), 4)]
    lay['avgCommScale'] = round(float(_scalar(pic, 'avgCommScale')), 4)
    lay['avgFaceSize'] = round(float(_scalar(pic, 'avgFaceSize')), 4)
    lay['_l2d'] = has_l2d
    return lay, 'ok'


def _f(obj, key):
    return obj[key] if isinstance(obj, dict) else getattr(obj, key)


def _scalar(obj, key):
    v = _f(obj, key)
    return v.x if hasattr(v, 'x') else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--bundle-root', default=DEFAULT_BUNDLES)
    args = ap.parse_args()
    base = os.path.join(args.bundle_root, 'res', 'character')
    out_dir = os.path.join(ROOT, 'data', 'layouts')
    done, fail, differ, same = {}, [], [], 0
    for d in sorted(os.listdir(base)):
        if not d.endswith('_avg'):
            continue
        dd = os.path.join(base, d)
        cands = [f for f in os.listdir(dd) if f.startswith('lpic_') and f.endswith('.ab')] \
            if os.path.isdir(dd) else []
        if not cands:
            fail.append((d, '无 lpic ab'))
            continue
        try:
            lay, why = hero_layout(os.path.join(dd, sorted(cands)[0]))
        except Exception as ex:                 # noqa: BLE001
            fail.append((d, f'{type(ex).__name__}: {ex}'))
            continue
        if lay is None:
            fail.append((d, why))
            continue
        done[d] = lay
        cur_p = os.path.join(out_dir, f'{d}.json')
        if os.path.isfile(cur_p):
            cur = json.load(open(cur_p, encoding='utf-8'))
            diff = {k: (cur.get(k), lay.get(k)) for k in lay
                    if k not in ('_l2d',) and _norm(cur.get(k)) != _norm(lay.get(k))}
            if diff:
                differ.append((d, diff))
            else:
                same += 1
    print(f'生成 {len(done)} 份 layout；失败 {len(fail)}；与人工标定件比对：{same} 份全等、'
          f'{len(differ)} 份有差异')
    print('失败样本：', fail[:6])
    for d, diff in differ[:6]:
        print(f'  {d}: ' + '; '.join(f'{k} 旧={a} 新={b}' for k, (a, b) in list(diff.items())[:3]))
    neg = [d for d, l in done.items() if l['m_LocalScale'] < 0]
    a0 = [d for d, l in done.items() if l.get('AvgHero1', {}).get('alpha') == 0]
    print(f'\n带镜像（m_LocalScale.x<0）的角色 {len(neg)} 个：{neg[:10]}')
    print(f'槽 1 官方 α=0 的角色 {len(a0)}/{len(done)}')
    if args.write:
        os.makedirs(out_dir, exist_ok=True)
        n = 0
        for d, lay in done.items():
            p = os.path.join(out_dir, f'{d}.json')
            if os.path.isfile(p):
                continue                        # 人工标定件优先，不覆盖
            out = {k: v for k, v in lay.items() if not k.startswith('_')}
            json.dump(out, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
            n += 1
        print(f'落盘 {n} 份新 layout 到 {out_dir}（已存在的 {len(done) - n} 份未动）')
    else:
        print('\n（干跑。加 --write 落盘，已存在的人工标定件不会被覆盖）')


def _norm(v):
    if isinstance(v, float):
        return round(v, 3)
    if isinstance(v, list):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v


if __name__ == '__main__':
    main()
