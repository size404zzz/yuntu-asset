# -*- coding: utf-8 -*-
"""M1 竖切导出驱动:croque 宿舍模型+动画、房间件、5 件家具 → dorm/assets/*.gltf。

用法: python export_dorm_m1.py
前提: res 目录在 MuMu 共享文件夹(路径见 BUNDLES)。
产出: <REPO>/dorm/assets/{croque_dorm, room_floor, room_wall, furn_*}.gltf
      + 同名 .bin + 贴图 PNG + manifest.json(各资产 AABB,供页面摆网格)
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anim_decode import decode_clip, tos_from_avatar          # noqa: E402
from export_gltf import (GltfBuilder, Hierarchy, decode_material,  # noqa: E402
                         decode_mesh, load_env, objects_by_pathid)

BUNDLES = r'C:\Users\Administrator\Documents\MuMu共享文件夹\bundles'
REPO = r'C:\Users\Administrator\Documents\GitHub\yuntu-asset'
OUT = os.path.join(REPO, 'dorm', 'assets')

CHARACTER = 'croque'
DORM_CLIPS = ['dorm_walk1', 'dorm_walk2', 'dorm_stand1', 'dorm_stand2',
              'dorm_sit', 'dorm_sit_loop', 'dorm_lie_start', 'dorm_lie_loop',
              'dorm_getup', 'dorm_getup_reverse', 'dorm_talk', 'dorm_fall',
              'dorm_float', 'dorm_toground']
FURNITURE = ['ab2024_sofa', 'ab2024_chair', 'ab2024_carpet', 'ab2024_deco01',
             'bamboo_shelf']

manifest = {'character': CHARACTER, 'assets': {}}


def components_of(objs, go_pid):
    """GameObject → 组件对象列表(已 read)。"""
    go = objs[go_pid].read()
    comps = []
    for c in go.m_Component:
        obj = objs.get(c.component.m_PathID) if hasattr(c, 'component') else objs.get(c.m_PathID)
        if obj is not None:
            comps.append((obj.type.name, obj.read()))
    return comps


def find_root_transform(env, objs):
    """优先 Animator 挂载点;否则取无父节点的根 Transform。"""
    for o in env.objects:
        if o.type.name != 'Animator':
            continue
        a = o.read()
        go_pid = a.m_GameObject.m_PathID
        for tobj in env.objects:
            if tobj.type.name == 'Transform' and tobj.read().m_GameObject.m_PathID == go_pid:
                return tobj.read(), go_pid
    for o in env.objects:
        if o.type.name != 'Transform':
            continue
        t = o.read()
        if t.m_Father.m_PathID == 0:
            return t, t.m_GameObject.m_PathID
    raise RuntimeError('bundle 里找不到根 Transform')


def go_to_transform_pids(env):
    """GameObject pid → Transform pid(整 env 预计算)。"""
    m = {}
    for o in env.objects:
        if o.type.name == 'Transform':
            m[o.read().m_GameObject.m_PathID] = o.path_id
    return m


def hier_to_gltf(builder, hier):
    """层级树 → glTF 节点;返回 (glTF根id列表, transform_pid→nodeid, path→nodeid)。"""
    pid2node = {}
    path2node = {}
    roots = []

    def walk(hidx, parent_gid):
        h = hier.nodes[hidx]
        gid = builder.add_node(h['name'], h['position'], h['rotation'], h['scale'])
        pid2node[h['transform_pid']] = gid
        path2node[h['path']] = gid
        if parent_gid is None:
            roots.append(gid)
        else:
            builder.json['nodes'][parent_gid].setdefault('children', []).append(gid)
        for c in h['children']:
            walk(c, gid)
        return gid

    walk(0, None)
    builder.json['scenes'][0]['nodes'] = roots
    return roots, pid2node, path2node


def _deref(env, pptr):
    """PPtr → 对象(跨包安全);失败返回 None。"""
    try:
        return pptr.read()
    except Exception:
        return None


def attach_static_meshes(builder, env, objs, hier, pid2node, texcache):
    """挂载网格:MeshFilter(静态)与 SkinnedMeshRenderer(骨骼家具)都处理。"""
    mats_used = {}
    tmap = go_to_transform_pids(env)

    def material_ids_for(go_pid):
        ids = []
        for o2 in env.objects:
            if o2.type.name != 'MeshRenderer' and o2.type.name != 'SkinnedMeshRenderer':
                continue
            r = o2.read()
            if r.m_GameObject.m_PathID != go_pid:
                continue
            for mp in r.m_Materials:
                mo = _deref(env, mp)
                if mo is None:
                    ids.append(None)
                    continue
                key = getattr(mo, 'path_id', id(mo))
                if key not in mats_used:
                    mdata = decode_material(mo.object_reader if hasattr(mo, 'object_reader') else mo,
                                            env, OUT, texcache)
                    mats_used[key] = builder.add_material(mdata, OUT)
                ids.append(mats_used[key])
            break
        return ids or [None]

    for o in env.objects:
        if o.type.name == 'MeshFilter':
            mf = o.read()
            go_pid = mf.m_GameObject.m_PathID
            gid = pid2node.get(tmap.get(go_pid))
            if gid is None:
                continue
            mesh = _deref(env, mf.m_Mesh)
            if mesh is None:
                continue
            md = decode_mesh(mesh)
            mesh_id = builder.add_mesh(md, material_ids_for(go_pid))
            builder.json['nodes'][gid]['mesh'] = mesh_id
            builder.json['nodes'][gid]['extras'] = {'aabb': md['aabb']}
        elif o.type.name == 'SkinnedMeshRenderer':
            s = o.read()
            go_pid = s.m_GameObject.m_PathID
            gid = pid2node.get(tmap.get(go_pid))
            if gid is None:
                continue
            mesh = _deref(env, s.m_Mesh)
            if mesh is None:
                continue
            md = decode_mesh(mesh)
            joint_nodes = []
            for b in s.m_Bones:
                # 骨骼在本 bundle 层级里,按 transform pid 对节点
                bid = None
                try:
                    bt = b.read()
                    bid = pid2node.get(bt.object_reader.path_id)
                except Exception:
                    pass
                joint_nodes.append(bid if bid is not None else 0)
            if md.get('bindposes'):
                skin_id = builder.add_skin(joint_nodes, md['bindposes'])
                builder.json['nodes'][gid]['skin'] = skin_id
            mesh_id = builder.add_mesh(md, material_ids_for(go_pid))
            builder.json['nodes'][gid]['mesh'] = mesh_id
            builder.json['nodes'][gid]['extras'] = {'aabb': md['aabb']}


def export_character():
    env = load_env(
        os.path.join(BUNDLES, r'res\character', CHARACTER, 'dmodel_%s.ab' % CHARACTER),
        os.path.join(BUNDLES, r'res\model\fbx\character', 'shared_%s_r.ab' % CHARACTER))
    objs = objects_by_pathid(env)
    root_t, root_go = find_root_transform(env, objs)
    hier = Hierarchy(env, _pid_of(root_t))
    builder = GltfBuilder(OUT, '%s_dorm' % CHARACTER)
    roots, pid2node, path2node = hier_to_gltf(builder, hier)
    texcache = {}
    tmap = go_to_transform_pids(env)

    # 蒙皮网格
    for o in env.objects:
        if o.type.name != 'SkinnedMeshRenderer':
            continue
        s = o.read()
        go_pid = s.m_GameObject.m_PathID
        gid = pid2node.get(tmap.get(go_pid))
        mesh_obj = objs.get(s.m_Mesh.m_PathID)
        if gid is None or mesh_obj is None:
            print('  跳过 SMR(节点/网格缺) ', go_pid)
            continue
        md = decode_mesh(mesh_obj.read())
        joint_nodes = []
        for b in s.m_Bones:
            bid = pid2node.get(b.m_PathID)
            joint_nodes.append(bid if bid is not None else 0)
        skin_id = builder.add_skin(joint_nodes, md['bindposes'])
        mat_ids = []
        for mp in s.m_Materials:
            mo = objs.get(mp.m_PathID)
            if mo is None:
                mat_ids.append(None)
                continue
            mdata = decode_material(mo, env, OUT, texcache)
            mat_ids.append(builder.add_material(mdata, OUT))
        mesh_id = builder.add_mesh(md, mat_ids)
        builder.json['nodes'][gid]['mesh'] = mesh_id
        builder.json['nodes'][gid]['skin'] = skin_id
        manifest['assets']['%s_dorm' % CHARACTER] = {
            'file': '%s_dorm.gltf' % CHARACTER,
            'aabb': md['aabb'], 'note': 'skinned mesh aabb(body)'}

    # 动画:croque 控制器 → 选定 clip
    av = [o for o in env.objects if o.type.name == 'Avatar'][0]
    tos = tos_from_avatar(av.read_typetree())
    denv = load_env(os.path.join(
        BUNDLES, r'res\model\fbx\dorm\dormanimationcontroller.ab'))
    dobjs = {o.path_id: o for o in denv.objects}
    ctrl = [o for o in dobjs.values()
            if o.type.name == 'AnimatorController'
            and o.read().m_Name == '%s_dorm_animator' % CHARACTER][0]
    ct = ctrl.read_typetree()
    exported = []
    for p in ct['m_AnimationClips']:
        cobj = dobjs.get(p['m_PathID'])
        if cobj is None or cobj.type.name != 'AnimationClip':
            continue
        tt = cobj.read_typetree()
        nm = tt.get('m_Name', '')
        if nm not in DORM_CLIPS:
            continue
        clip = decode_clip(tt, tos)
        builder.add_animation(nm, clip['tracks'], path2node,
                              clip['stopTime'])
        exported.append((nm, len(clip['tracks']), round(clip['stopTime'], 3)))
    print('动画:', exported)
    fn = builder.save()
    print('导出', fn)


def _pid_of(obj):
    return obj.object_reader.path_id if hasattr(obj, 'object_reader') else obj.path_id


def export_static(name, prefab_rel, shared_rels):
    env = load_env(os.path.join(BUNDLES, prefab_rel),
                   *[os.path.join(BUNDLES, s) for s in shared_rels])
    objs = objects_by_pathid(env)
    root_t, root_go = find_root_transform(env, objs)
    hier = Hierarchy(env, _pid_of(root_t))
    builder = GltfBuilder(OUT, name)
    roots, pid2node, path2node = hier_to_gltf(builder, hier)
    texcache = {}
    attach_static_meshes(builder, env, objs, hier, pid2node, texcache)
    fn = builder.save()
    # 汇总 AABB(取所有带网格节点 extras 的包络)
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for n in builder.json['nodes']:
        a = n.get('extras', {}).get('aabb')
        if a:
            for i in range(3):
                lo[i] = min(lo[i], a[i])
                hi[i] = max(hi[i], a[i + 3])
    if lo[0] < 1e8:
        manifest['assets'][name] = {'file': name + '.gltf',
                                    'aabb': lo + hi}
    print('导出', fn, 'aabb=', [round(x, 3) for x in lo + hi] if lo[0] < 1e8 else '空')


def main():
    os.makedirs(OUT, exist_ok=True)
    print('== 角色:', CHARACTER)
    export_character()

    furn_base = r'res\model\dorm\furnitures\furnitures_001'
    for f in FURNITURE:
        print('== 家具:', f)
        export_static('furn_' + f,
                      os.path.join(furn_base, 'prefabs', f + '.ab'),
                      [os.path.join(furn_base, 'shared_textures.ab'),
                       os.path.join(furn_base, 'shared_materials_r.ab'),
                       os.path.join(furn_base, 'shared_models.ab')])
    room_base = r'res\model\dorm\furnitures\rooms_001'
    for f in ('ab2024_floor', 'ab2024_wall'):
        print('== 房间件:', f)
        export_static('room_' + f,
                      os.path.join(room_base, 'prefabs', f + '.ab'),
                      [os.path.join(room_base, 'shared_textures.ab'),
                       os.path.join(room_base, 'shared_materials_r.ab'),
                       os.path.join(room_base, 'shared_lightmaps.ab')])
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=1)
    print('manifest ->', os.path.join(OUT, 'manifest.json'))


if __name__ == '__main__':
    main()
