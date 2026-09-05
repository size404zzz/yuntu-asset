# -*- coding: utf-8 -*-
"""Unity AssetBundle → glTF 2.0 导出器(M1 竖切专用子集)。

覆盖:静态网格、蒙皮网格(2/4 权重)、材质+主贴图、骨架层级、
动画轨道(anim_decode.decode_clip 的输出)。
坐标:Unity(左手,Y上,Z前)→ glTF(右手,Y上,-Z前):
  position (x,y,-z) / quaternion (-x,-y,z,w) / 矩阵做 Z 镜像共轭。

顶点通道按 Unity 2021+ 通道序解码:
  0 pos f32x3 · 1 normal f32x3 · 2 tangent f32x4 · 3 color unorm8x4 ·
  4.. UV · 12 blendWeight f32xN · 13 blendIndices uint32xN
"""
import io
import json
import os
import struct

import UnityPy

# ---------------------------------------------------------------- env loading

def load_env(*paths):
    """多个 bundle 合并进一个 Environment,跨包 PPtr 可解;剥假头。"""
    env = UnityPy.Environment()
    for p in paths:
        raw = open(p, 'rb').read()
        i = raw.find(b'UnityFS')
        env.load_file(io.BytesIO(raw[i:] if i >= 0 else raw), os.path.basename(p))
    return env


def objects_by_pathid(env):
    return {o.path_id: o for o in env.objects if o.path_id}

# ---------------------------------------------------------------- vertex data

_FMT_SIZE = {0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4}
# 本作实测通道语义(字节级验证):
#   0 pos f32x3 · 1 normal f32x3 · 2 tangent f32x4 · 3 color unorm8x4 ·
#   4 UV0(f16/f32)x2 · 12 blendIndices f32xN · 13 blendWeight(u32 位型 f32)xN


def _stream_strides(chs):
    strides = {}
    for s, off, fmt, dim in chs:
        if dim == 0:
            continue
        end = off + dim * _FMT_SIZE.get(fmt, 4)
        strides[s] = max(strides.get(s, 0), end)
    return strides


def _stream_bases(chs, strides, vcount):
    """各流起始字节:流区域按 16 字节对齐补齐(实测两网格总长精确吻合)。"""
    bases = {}
    acc = 0
    for s in sorted(strides):
        bases[s] = acc
        acc += (vcount * strides[s] + 15) // 16 * 16
    return bases


def _read_comp(buf, base, fmt, n):
    if fmt == 0:
        return struct.unpack_from('<%df' % n, buf, base)
    if fmt == 1:
        return struct.unpack_from('<%de' % n, buf, base)
    if fmt == 2:                                     # unorm8
        return tuple(x / 255.0 for x in buf[base:base + n])
    if fmt == 3:                                     # snorm16
        return tuple(max(-1.0, x / 32767.0) for x in struct.unpack_from('<%dh' % n, buf, base))
    if fmt == 4:                                     # unorm8
        return tuple(x / 255.0 for x in buf[base:base + n])
    if fmt == 5:                                     # snorm8
        return tuple(max(-1.0, (x - 127.5) / 127.5) for x in buf[base:base + n])
    if fmt == 6:
        return tuple(buf[base:base + n])
    if fmt == 7:
        return tuple(x - 256 if x > 127 else x for x in buf[base:base + n])
    if fmt == 8:
        return struct.unpack_from('<%dH' % n, buf, base)
    if fmt == 9:
        return struct.unpack_from('<%dh' % n, buf, base)
    if fmt == 10:
        return struct.unpack_from('<%dI' % n, buf, base)
    if fmt == 11:
        return struct.unpack_from('<%di' % n, buf, base)
    raise ValueError('未知顶点格式 %d' % fmt)


def _vertex_bytes(mesh):
    """顶点数据:m_DataSize 内联;否则经 m_StreamData 从 .resS 解析。"""
    data = bytes(mesh.m_VertexData.m_DataSize) if hasattr(mesh.m_VertexData, 'm_DataSize') else b''
    if data:
        return data
    sd = getattr(mesh, 'm_StreamData', None)
    if sd is None or not getattr(sd, 'path', ''):
        return b''
    af = mesh.object_reader.assets_file
    env = af.environment
    f = env.find_file(sd.path)
    if f is None:
        return b''
    f.Position = sd.offset
    return bytes(f.read_bytes(sd.size))


def _sanitize_channels(chs):
    """个别网格(如家具压缩导出)的 channel dimension 字段损坏(如 52),
    按同流内下一通道的 offset 收敛尺寸;保持通道原位(调用方按位取用)。"""
    out = []
    for i, (st, off, fmt, dim) in enumerate(chs):
        size = dim * _FMT_SIZE.get(fmt, 4)
        nxt = None
        for j in range(i + 1, len(chs)):
            if chs[j][0] == st and chs[j][1] > off:
                nxt = chs[j][1]
                break
        if nxt is not None and size > nxt - off:
            avail = nxt - off
            size = avail - avail % _FMT_SIZE.get(fmt, 4)
        if size <= 0:
            out.append((st, off, fmt, 0))
            continue
        d = size // _FMT_SIZE.get(fmt, 4)
        out.append((st, off, fmt, min(d, dim) if dim <= 64 else d))
    return out


def decode_mesh(mesh):
    """→ {positions, normals, uvs, submeshes[tri], weights, joints, bindposes, aabb}"""
    vd = mesh.m_VertexData
    vcount = vd.m_VertexCount
    chs = _sanitize_channels([(c.stream, c.offset, c.format, c.dimension)
                              for c in vd.m_Channels])
    strides = _stream_strides(chs)
    bases = _stream_bases(chs, strides, vcount)
    data = _vertex_bytes(mesh)
    if not data:
        raise RuntimeError('mesh %s 顶点数据为空(.resS 不可解析)' % mesh.m_Name)
    # 内联数据实测带 16B 流对齐;外部 .resS 实测无对齐(容量紧贴)。
    padded = sum((vcount * strides[s] + 15) // 16 * 16 for s in strides)
    if len(data) < padded:
        bases = {s: 0 for s in strides}
        acc = 0
        for s in sorted(strides):
            bases[s] = acc
            acc += vcount * strides[s]

    def get_channel(idx):
        s, off, fmt, dim = chs[idx]
        if dim == 0:
            return None
        stride = strides[s]
        base0 = bases[s]
        out = []
        for v in range(vcount):
            out.append(_read_comp(data, base0 + v * stride + off, fmt, dim))
        return out

    pos = get_channel(0)
    nor = get_channel(1)
    uv0 = get_channel(4)
    bw = get_channel(12)          # blendWeight f32xN
    bi = get_channel(13)          # blendIndices u32xN

    positions = []
    for p in pos:
        positions.extend((p[0], p[1], -p[2]))
    normals = []
    if nor:
        for n in nor:
            normals.extend((n[0], n[1], -n[2]))
    uvs = []
    if uv0:
        for u in uv0:                       # dim 2 或 4,取前两分量
            uvs.extend((u[0], 1.0 - u[1]))
    weights = [list(w) for w in bw] if bw else None
    joints = [[int(v) for v in j] for j in bi] if bi else None

    ibuf = bytes(mesh.m_IndexBuffer)
    fmt32 = bool(getattr(mesh, 'm_IndexFormat', 0) == 1)
    submeshes = []
    for sm in mesh.m_SubMeshes:
        first = sm.firstByte
        cnt = sm.indexCount
        if fmt32:
            idx = struct.unpack_from('<%dI' % cnt, ibuf, first)
        else:
            idx = struct.unpack_from('<%dH' % cnt, ibuf, first)
        tri = []
        for i in range(0, len(idx) - 2, 3):
            tri.extend((idx[i], idx[i + 2], idx[i + 1]))   # 镜像 Z → 翻转绕序
        submeshes.append(tri)

    # bindposes:e00..e33 行主序 → 列主序(供 _conj_z 消费)
    bindposes = None
    if mesh.m_BindPose:
        bindposes = []
        for bp in mesh.m_BindPose:
            bindposes.append([getattr(bp, 'e%01d%01d' % (r, c))
                              for c in range(4) for r in range(4)])

    return {
        'name': mesh.m_Name,
        'positions': positions,
        'normals': normals,
        'uvs': uvs,
        'submeshes': submeshes,
        'weights': weights,
        'joints': joints,
        'bindposes': bindposes,
        'aabb': _aabb(positions),
    }


def _aabb(positions):
    return [min(positions[0::3]), min(positions[1::3]), min(positions[2::3]),
            max(positions[0::3]), max(positions[1::3]), max(positions[2::3])]

# ---------------------------------------------------------------- materials

def decode_material(mat, env, texdir, texcache):
    """Material → {name, baseColorFactor, baseColorTexture, alphaMode, queue}"""
    m = mat.read()
    out = {'name': m.m_Name}
    color = [1.0, 1.0, 1.0, 1.0]
    texfn = None
    saved = getattr(m, 'm_SavedProperties', None)
    if saved is not None:
        for k, v in saved.m_Colors:
            if k in ('_Color', '_MainColor'):
                color = [v.r, v.g, v.b, v.a]
        objs = objects_by_pathid(env)
        for k, v in saved.m_TexEnvs:
            if k.lower() in ('_maintex', '_basemap', '_basetexture'):
                pid = v.m_Texture.m_PathID
                if pid:
                    tobj = objs.get(pid)
                    if tobj is not None:
                        texfn = _tex_image(tobj.read(), texdir, texcache)
                break
    out['baseColorFactor'] = list(color)
    out['baseColorTexture'] = texfn
    try:
        rq = int(getattr(m, 'm_CustomRenderQueue', 2000))
    except (TypeError, ValueError):
        rq = 2000
    if rq < 0:
        rq = 2000
    out['queue'] = rq
    alpha_tex = False
    if texfn:
        try:
            from PIL import Image
            img = Image.open(os.path.join(texdir, texfn))
            alpha_tex = img.mode in ('RGBA', 'LA', 'PA')
        except Exception:
            pass
    if rq >= 3000:
        out['alphaMode'] = 'BLEND'
    elif rq >= 2450 and alpha_tex:
        out['alphaMode'] = 'MASK'
    else:
        out['alphaMode'] = 'OPAQUE'
    return out


def _tex_image(tex, texdir, cache):
    name = tex.m_Name or ('tex_%d' % (tex.path_id if hasattr(tex, 'path_id') else 0))
    if name in cache:
        return cache[name]
    try:
        img = tex.image
    except Exception as e:
        print('  贴图解码失败 %s: %s' % (name, e))
        cache[name] = None
        return None
    os.makedirs(texdir, exist_ok=True)
    fn = name + '.png'
    img.save(os.path.join(texdir, fn))
    cache[name] = fn
    return fn

# ---------------------------------------------------------------- transforms

def _q_unity_to_gltf(q, normalize=True):
    x, y, z, w = q
    out = (-x, -y, z, w)
    if normalize:
        n = sum(c * c for c in out) ** 0.5
        if n > 1e-8:
            out = tuple(c / n for c in out)
    return out


def _conj_z(m16_colmajor):
    """M·A·M⁻¹,M=diag(1,1,-1);Unity Matrix4x4 列主存储。r=2 或 c=2 的元素取负。"""
    m = list(m16_colmajor)
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            v = m[c * 4 + r]
            if (r == 2) != (c == 2):
                v = -v
            out[c * 4 + r] = v
    return out

# ---------------------------------------------------------------- hierarchy

_RESERVED = str.maketrans({'/': '_', ' ': '_', '.': '_', '[': '_', ']': '_'})


class Hierarchy:
    """从某 Transform 根遍历;node.name = 净化后的骨骼全路径(保证唯一,轨道可寻址)。

    path 相对遍历根(= Animator 节点),与 clip 的骨骼路径同基。
    """

    def __init__(self, env, root_transform_pid):
        self.objs = objects_by_pathid(env)
        self.nodes = []
        self.path2node = {}
        self._walk(root_transform_pid, None, [])

    def _walk(self, tpid, parent, path):
        t = self.objs[tpid].read()
        go = t.m_GameObject.read()
        p = path + [go.m_Name]
        pstr = '/'.join(p)
        node = {
            'transform_pid': tpid,
            'name': pstr.translate(_RESERVED),
            'path': pstr,
            'position': (t.m_LocalPosition.x, t.m_LocalPosition.y, t.m_LocalPosition.z),
            'rotation': (t.m_LocalRotation.x, t.m_LocalRotation.y,
                         t.m_LocalRotation.z, t.m_LocalRotation.w),
            'scale': (t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z),
            'children': [],
        }
        idx = len(self.nodes)
        self.nodes.append(node)
        if parent is not None:
            parent['children'].append(idx)
        self.path2node[pstr] = idx
        for ch in t.m_Children:
            self._walk(ch.m_PathID, node, p)
        return idx

# ---------------------------------------------------------------- glTF writer

class GltfBuilder:
    """手写 glTF 2.0(JSON + bin + 外部贴图)。"""

    def __init__(self, outdir, name):
        self.outdir = outdir
        self.name = name
        self.json = {
            'asset': {'version': '2.0', 'generator': 'yuntu-dorm-m1'},
            'scenes': [{'nodes': []}],
            'nodes': [], 'meshes': [], 'materials': [], 'skins': [],
            'accessors': [], 'bufferViews': [], 'animations': [],
        }
        self.bin = bytearray()
        self.images = []
        self.textures = []
        self._tex_cache = {}

    # --- buffer ---
    def _acc(self, data, comp_type, type_, count, minmax=False):
        self.bin.extend(b'\0' * ((4 - len(self.bin) % 4) % 4))
        bv = {'buffer': 0, 'byteOffset': len(self.bin),
              'byteLength': len(data)}
        self.bin.extend(data)
        self.json['bufferViews'].append(bv)
        acc = {'bufferView': len(self.json['bufferViews']) - 1,
               'componentType': comp_type, 'count': count, 'type': type_}
        if minmax:
            n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[type_]
            vals = struct.unpack('<%d%s' % (count * n, {5126: 'f', 5123: 'H', 5125: 'I'}[comp_type]), data)
            mn, mx = [], []
            for c in range(n):
                col = vals[c::n]
                mn.append(min(col))
                mx.append(max(col))
            acc['min'] = mn
            acc['max'] = mx
        self.json['accessors'].append(acc)
        return len(self.json['accessors']) - 1

    def _f32(self, seq):
        return struct.pack('<%df' % len(seq), *seq)

    def _u32(self, seq):
        return struct.pack('<%dI' % len(seq), *seq)

    def _u16(self, seq):
        return struct.pack('<%dH' % len(seq), *seq)

    # --- nodes ---
    def add_node(self, name, position=None, rotation=None, scale=None):
        n = {'name': name}
        if position is not None:
            n['translation'] = [position[0], position[1], -position[2]]
        if rotation is not None:
            n['rotation'] = list(_q_unity_to_gltf(rotation))
        if scale is not None:
            n['scale'] = list(scale)
        self.json['nodes'].append(n)
        return len(self.json['nodes']) - 1

    # --- mesh ---
    def add_mesh(self, md, material_ids):
        """md=decode_mesh 输出;material_ids 按子网格。返回 glTF mesh id。"""
        pos_acc = self._acc(self._f32(md['positions']), 5126, 'VEC3', len(md['positions']) // 3, True)
        prims = []
        attrs = {'POSITION': pos_acc}
        if md['normals']:
            attrs['NORMAL'] = self._acc(self._f32(md['normals']), 5126, 'VEC3', len(md['normals']) // 3)
        if md['uvs']:
            attrs['TEXCOORD_0'] = self._acc(self._f32(md['uvs']), 5126, 'VEC2', len(md['uvs']) // 2)
        nverts = len(md['positions']) // 3
        if md.get('joints') and md.get('weights'):
            # glTF 规定 JOINTS_0 为 u8/u16;权重不足 4 分量补零
            joints4 = []
            weights4 = []
            for j, w in zip(md['joints'], md['weights']):
                j = list(j) + [0] * (4 - len(j))
                w = list(w) + [0.0] * (4 - len(w))
                joints4.extend(j[:4])
                weights4.extend(w[:4])
            attrs['JOINTS_0'] = self._acc(self._u16(joints4), 5123, 'VEC4', nverts)
            attrs['WEIGHTS_0'] = self._acc(self._f32(weights4), 5126, 'VEC4', nverts)
        for si, tri in enumerate(md['submeshes']):
            idx_acc = self._acc(self._u32(tri), 5125, 'SCALAR', len(tri))
            prim = {'attributes': attrs, 'indices': idx_acc, 'mode': 4}
            if si < len(material_ids) and material_ids[si] is not None:
                prim['material'] = material_ids[si]
            prims.append(prim)
        self.json['meshes'].append({'name': md['name'], 'primitives': prims})
        return len(self.json['meshes']) - 1

    def add_material(self, md, texdir):
        m = {'name': md['name'],
             'pbrMetallicRoughness': {'baseColorFactor': md['baseColorFactor'],
                                      'metallicFactor': 0.0, 'roughnessFactor': 0.9}}
        fn = md['baseColorTexture']
        if fn:
            if fn not in self._tex_cache:
                img = {'uri': os.path.basename(fn)}
                self.json.setdefault('images', []).append(img)
                self.json.setdefault('textures', []).append(
                    {'source': len(self.json['images']) - 1})
                self._tex_cache[fn] = len(self.json['textures']) - 1
            m['pbrMetallicRoughness']['baseColorTexture'] = {
                'index': self._tex_cache[fn]}
        if md['alphaMode'] != 'OPAQUE':
            m['alphaMode'] = md['alphaMode']
            if md['alphaMode'] == 'MASK':
                m['alphaCutoff'] = 0.5
            m['doubleSided'] = True
        self.json['materials'].append(m)
        return len(self.json['materials']) - 1

    # --- skin ---
    def add_skin(self, joint_node_ids, ibm_unity_colmajor):
        ibms = []
        for m in ibm_unity_colmajor:
            g = _conj_z(m)
            ibms.extend(g)
        acc = self._acc(self._f32(ibms), 5126, 'MAT4', len(ibm_unity_colmajor))
        self.json['skins'].append({'joints': joint_node_ids,
                                   'inverseBindMatrices': acc,
                                   'skeleton': joint_node_ids[0]})
        return len(self.json['skins']) - 1

    # --- animations ---
    def add_animation(self, name, tracks, path2node, stop):
        """tracks = anim_decode 输出;path→glTF node id 映射。

        clip 路径相对 Animator 根,层级路径多一层根名 → 后缀匹配。
        """
        def resolve(p):
            if p in path2node:
                return path2node[p]
            tail = '/' + p
            best = None
            for hp, nid in path2node.items():
                if hp.endswith(tail) and (best is None or len(hp) < len(best[0])):
                    best = (hp, nid)
            return best[1] if best else None

        channels = []
        samplers = []
        for tr in tracks:
            nid = resolve(tr['path'])
            if nid is None:
                continue
            times = tr['times']
            vals = tr['values']
            attr = tr['attr']
            if attr == 'position':
                conv = []
                for i in range(0, len(vals), 3):
                    conv.extend((vals[i], vals[i + 1], -vals[i + 2]))
                prop = 'translation'
                ncomp = 3
            elif attr == 'rotation':
                conv = []
                for i in range(0, len(vals), 4):
                    q = _q_unity_to_gltf(vals[i:i + 4])
                    conv.extend(q)
                prop = 'rotation'
                ncomp = 4
            else:
                conv = list(vals)
                prop = 'scale'
                ncomp = 3
            t_acc = self._acc(self._f32(times), 5126, 'SCALAR', len(times))
            v_acc = self._acc(self._f32(conv), 5126,
                              {3: 'VEC3', 4: 'VEC4'}[ncomp], len(conv) // ncomp)
            samplers.append({'input': t_acc, 'output': v_acc, 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1,
                             'target': {'node': nid, 'path': prop}})
        if channels:
            self.json['animations'].append({'name': name, 'channels': channels,
                                            'samplers': samplers})

    # --- output ---
    def save(self):
        os.makedirs(self.outdir, exist_ok=True)
        binfn = self.name + '.bin'
        with open(os.path.join(self.outdir, binfn), 'wb') as f:
            f.write(self.bin)
        self.json['buffers'] = [{'uri': binfn,
                                 'byteLength': len(self.bin)}]
        # 清掉空数组,减小体积
        for k in ('meshes', 'materials', 'skins', 'animations', 'images', 'textures'):
            if not self.json.get(k):
                self.json.pop(k, None)
        with open(os.path.join(self.outdir, self.name + '.gltf'), 'w',
                  encoding='utf-8') as f:
            json.dump(self.json, f, ensure_ascii=False, separators=(',', ':'))
        return self.name + '.gltf'
