# -*- coding: utf-8 -*-
"""M2 导出:家具目录(含 BoxCollider 占位)+ DormConfigAsset 交互数据 JSON。

产出:
  dorm/assets/furn_<名>.gltf            家具模型(复用 M1 export_static 路径)
  dorm/assets/manifest.json             追加 footprint(collider 尺寸/中心)
  data/dorm/furniture-catalog.json      目录(名字/主题/footprint/可交互 anims)
  data/dorm/dorm-interact.json          DormConfigAsset 全量交互配置
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_gltf import load_env, objects_by_pathid  # noqa: E402
import export_dorm_m1 as m1  # noqa: E402

BUNDLES = m1.BUNDLES
REPO = m1.REPO
OUT = m1.OUT

# 目录:ab2024 套系 + 实机抓包得到的全部家具(dorm-scene-full 场景转储)
CATALOG = [
    # ab2024 套系
    'ab2024_sofa', 'ab2024_chair', 'ab2024_carpet', 'ab2024_deco01',
    'ab2024_door', 'ab2024_walldeco01', 'ab2024_walldeco02',
    # 可交互(角色有专属互动动画)
    'anniversary1_bar', 'anniversary2_table', 'anniversary3_pool',
    'anniversary4_chair', 'srt2022_drumset',
    'dwc2022_sofa_01', 'dwc2022_chair_01', 'dwc2022_table_01',
    'dwc2022_deco_04', 'dwc2022_deco_05',
    'etj2018_deco_004', 'etj2018_deco_005', 'etj2018_deco_009',
    # 实机抓包(用户宿舍 7 房间实际使用的家具)
    'do2022_sofa', 'do2022_chair', 'do2022_table', 'do2022_deco_01',
    'do2022_deco_02', 'do2022_deco_03',
    'sd2016_sofa_001', 'sd2016_chair_001', 'sd2016_table_001',
    'sd2016_bed_001', 'sd2016_tree_001',
    'se2021_boat_001', 'se2021_hammock_001', 'se2021_lantern_001',
    'se2021_motorboat_001', 'se2021_surfboard_001', 'se2021_table_001',
    'sef2022_sofa', 'sef2022_chair', 'sef2022_deco_01', 'sef2022_deco_02',
    'sef2022_deco_03', 'sef2022_deco_04',
    'syp2017_bed_001', 'syp2017_chair_001', 'syp2017_table_001',
    'syp2017_table_002', 'syp2017_deco_001', 'syp2017_deco_002',
    'syp2017_deco_003', 'syp2017_deco_004', 'syp2017_deco_005',
    'syp2017_deco_006',
    'we2021_bed_001', 'we2021_chair_001', 'we2021_sofa_001',
    'we2021_sofa_002', 'we2021_table_001', 'we2021_deco_001',
    'we2021_walldeco_001',
    'xn2018_bed_001', 'xn2018_chair_01', 'xn2018_chair_002',
    'xn2018_desk_001', 'xn2018_deco_004', 'xn2018_deco_008',
    'xn2018_bonfire_001',
]

FURN_BASE = r'res\model\dorm\furnitures\furnitures_001'
SHARED = [os.path.join(FURN_BASE, s) for s in
          ('shared_textures.ab', 'shared_materials_r.ab', 'shared_models.ab')]


def read_collider(env, objs, go_pid):
    """GameObject 的第一个 BoxCollider → {center, size}(本地系,Unity 坐标)。"""
    go = objs[go_pid].read()
    for c in go.m_Component:
        obj = objs.get(c.component.m_PathID if hasattr(c, 'component') else c.m_PathID)
        if obj is not None and obj.type.name == 'BoxCollider':
            b = obj.read()
            return {
                'center': [b.m_Center.x, b.m_Center.y, b.m_Center.z],
                'size': [b.m_Size.x, b.m_Size.y, b.m_Size.z],
            }
    return None


def export_catalog():
    manifest_path = os.path.join(OUT, 'manifest.json')
    # 与 m1 共享同一 manifest 对象(export_static 就地更新它)
    if os.path.isfile(manifest_path):
        m1.manifest = json.load(open(manifest_path, encoding='utf-8'))
    catalog = []
    for name in CATALOG:
        prefab = os.path.join(BUNDLES, FURN_BASE, 'prefabs', name + '.ab')
        if not os.path.isfile(prefab):
            print('缺 prefab:', name)
            continue
        env = load_env(prefab, *[os.path.join(BUNDLES, s) for s in SHARED])
        objs = objects_by_pathid(env)
        colliders = []
        for o in env.objects:
            if o.type.name != 'BoxCollider':
                continue
            b = o.read()
            go_pid = b.m_GameObject.m_PathID
            goname = objs[go_pid].read().m_Name if go_pid in objs else '?'
            colliders.append({'node': goname,
                              'center': [b.m_Center.x, b.m_Center.y, b.m_Center.z],
                              'size': [b.m_Size.x, b.m_Size.y, b.m_Size.z]})
        key = 'furn_' + name
        if key not in m1.manifest['assets']:
            m1.export_static(key, os.path.join(FURN_BASE, 'prefabs', name + '.ab'), SHARED)
        aabb = m1.manifest['assets'].get(key, {}).get('aabb')
        catalog.append({
            'id': name,
            'file': key + '.gltf',
            'theme': name.split('_')[0],
            'aabb': aabb,
            'colliders': colliders,
        })
        print('catalog:', name, '| colliders:', len(colliders),
              '| aabb:', '有' if aabb else '无')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(m1.manifest, f, ensure_ascii=False, indent=1)
    cat_path = os.path.join(REPO, 'data', 'dorm', 'furniture-catalog.json')
    os.makedirs(os.path.dirname(cat_path), exist_ok=True)
    json.dump({'gridCell': 0.5, 'floorSize': [4.0, 4.0], 'items': catalog},
              open(cat_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('catalog ->', cat_path, '(%d 件)' % len(catalog))


def _curve(c):
    """UnityPy AnimationCurve typetree → {keys: [[t,v],...]}"""
    out = []
    for k in c.get('m_Curve', []):
        out.append([k.get('time'), k.get('value')])
    return {'keys': out}


def export_dorm_config():
    env = load_env(os.path.join(BUNDLES, r'res\scriptableconfig\dormconfigasset.ab'))
    cfg = None
    for o in env.objects:
        if o.type.name == 'MonoBehaviour':
            tt = o.read_typetree()
            if tt.get('m_Name') == 'DormConfigAsset':
                cfg = tt
                break
    if cfg is None:
        raise RuntimeError('DormConfigAsset 未找到')
    out = {'dispositions': [], 'characters': {}}
    for d in cfg.get('dispositions', []):
        out['dispositions'].append({
            'dispositionType': d.get('dispositionType'),
            'moveCurves': [{
                'moveX': _curve(mc.get('moveX', {})),
                'moveY': _curve(mc.get('moveY', {})),
                'moveZ': _curve(mc.get('moveZ', {})),
                'moveTime': mc.get('moveTime'),
            } for mc in d.get('moveCurves', [])],
        })
    for cd in cfg.get('charDispositions', []):
        nm = cd.get('charcterName')
        if not nm:
            continue
        out['characters'][nm] = [{
            'animType': it.get('animType'),
            'dispositionType': it.get('dispositionType'),
        } for it in cd.get('interactArray', [])]
    path = os.path.join(REPO, 'data', 'dorm', 'dorm-interact.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('dorm-interact ->', path,
          '| 角色数:', len(out['characters']), '| 交互类型:', len(out['dispositions']))


def main():
    os.makedirs(OUT, exist_ok=True)
    export_catalog()
    export_dorm_config()


if __name__ == '__main__':
    main()
