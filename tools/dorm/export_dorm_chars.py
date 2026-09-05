# -*- coding: utf-8 -*-
"""宿舍角色批量导出:professor/sol/simo/taisch/turing → dorm/assets/char_<名>.gltf。

共享包解析:dmodel 的 AssetBundle.m_Dependencies(CAB 名)→ cab-index.json
(UnityPy 扫描各 shared 包内部 SerializedFile 名建立)。贴图包缺 Crew 的
(sol/taisch/turing)导出后为灰模,拿到包后重跑本脚本即可。

用法: python export_dorm_chars.py [名字 ...]
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anim_decode import decode_clip, tos_from_avatar          # noqa: E402
from export_gltf import (GltfBuilder, Hierarchy, decode_material,  # noqa: E402
                         decode_mesh, load_env, objects_by_pathid)
import export_dorm_m1 as m1                                   # noqa: E402

BUNDLES = m1.BUNDLES
OUT = m1.OUT
DORM_CTRL = os.path.join(BUNDLES, r'res\model\fbx\dorm\dormanimationcontroller.ab')

# 巡游需要的动画子集
CLIPS = ['dorm_walk1', 'dorm_walk2', 'dorm_stand1', 'dorm_stand2',
         'dorm_sit', 'dorm_sit_loop', 'dorm_lie_start', 'dorm_lie_loop',
         'dorm_getup', 'dorm_talk']

CHARS = ['professor', 'simo', 'sol', 'taisch', 'turing']


def resolve_shared(name, cab_index):
    """dmodel 依赖表 → 共享包路径列表(去重保序)。"""
    env = load_env(os.path.join(BUNDLES, r'res\character', name, 'dmodel_%s.ab' % name))
    paths = [os.path.join(BUNDLES, r'res\model\fbx\character', 'shared_%s_r.ab' % name)]
    if not os.path.isfile(paths[0]):
        paths = []
    for o in env.objects:
        if o.type.name != 'AssetBundle':
            continue
        for dep in (getattr(o.read(), 'm_Dependencies', []) or []):
            p = cab_index.get(dep.lower())
            if p and p not in paths:
                paths.append(os.path.join(BUNDLES, p))
    return paths


def export_one(name, cab_index):
    shared = resolve_shared(name, cab_index)
    env = load_env(os.path.join(BUNDLES, r'res\character', name, 'dmodel_%s.ab' % name),
                   *shared)
    objs = objects_by_pathid(env)
    root_t, _ = m1.find_root_transform(env, objs)
    hier = Hierarchy(env, m1._pid_of(root_t))
    builder = GltfBuilder(OUT, 'char_%s' % name)
    roots, pid2node, path2node = m1.hier_to_gltf(builder, hier)
    texcache = {}
    tmap = m1.go_to_transform_pids(env)

    meshes = 0
    for o in env.objects:
        if o.type.name != 'SkinnedMeshRenderer':
            continue
        s = o.read()
        go_pid = s.m_GameObject.m_PathID
        gid = pid2node.get(tmap.get(go_pid))
        mesh = m1._deref(env, s.m_Mesh)
        if gid is None or mesh is None:
            continue
        md = decode_mesh(mesh)
        joint_nodes = []
        for b in s.m_Bones:
            bid = None
            try:
                bt = b.read()
                bid = pid2node.get(bt.object_reader.path_id)
            except Exception:
                pass
            joint_nodes.append(bid if bid is not None else 0)
        if md.get('bindposes'):
            builder.json['nodes'][gid]['skin'] = builder.add_skin(joint_nodes, md['bindposes'])
        mat_ids = []
        for mp in s.m_Materials:
            mo = m1._deref(env, mp)
            if mo is None:
                mat_ids.append(None)
                continue
            key = getattr(mo, 'object_reader', None).path_id if hasattr(mo, 'object_reader') else id(mo)
            mdata = decode_material(mo, env, OUT, texcache)
            mat_ids.append(builder.add_material(mdata, OUT))
        builder.json['nodes'][gid]['mesh'] = builder.add_mesh(md, mat_ids)
        meshes += 1

    # 宿舍动画
    av = [o for o in env.objects if o.type.name == 'Avatar'][0]
    tos = tos_from_avatar(av.read_typetree())
    denv = load_env(DORM_CTRL)
    dobjs = {o.path_id: o for o in denv.objects}
    ctrl = [o for o in dobjs.values()
            if o.type.name == 'AnimatorController'
            and o.read().m_Name == '%s_dorm_animator' % name]
    exported = 0
    if ctrl:
        ct = ctrl[0].read_typetree()
        for p in ct['m_AnimationClips']:
            cobj = dobjs.get(p['m_PathID'])
            if cobj is None or cobj.type.name != 'AnimationClip':
                continue
            tt = cobj.read_typetree()
            if tt.get('m_Name') not in CLIPS:
                continue
            clip = decode_clip(tt, tos)
            builder.add_animation(tt['m_Name'], clip['tracks'], path2node, clip['stopTime'])
            exported += 1
    fn = builder.save()
    print('%s: meshes=%d anims=%d shared=%d -> %s'
          % (name, meshes, exported, len(shared), fn))
    return {'file': 'char_%s.gltf' % name, 'meshes': meshes, 'anims': exported,
            'textured': any(True for _ in texcache)}


def main():
    os.makedirs(OUT, exist_ok=True)
    idx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cab-index.json')
    cab_index = json.load(open(idx_path, encoding='utf-8'))
    names = sys.argv[1:] or CHARS
    for n in names:
        try:
            export_one(n, cab_index)
        except Exception as e:
            print('%s 失败: %r' % (n, e))


if __name__ == '__main__':
    main()
