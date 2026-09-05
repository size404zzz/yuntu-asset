# -*- coding: utf-8 -*-
"""Unity 动画 clip(运行时打包格式)→ 通用线性轨道。

格式参考:UtinyRipper StreamedClip/DenseClip/ConstantClip + AssetRipper
AnimationClipConverter。运行时插值 = Hermite 三次曲线,这里统一重采样成
线性关键帧(dense 层本来就是采样帧,直接线性;streamed 层按 sampleRate×
oversample 重采样;constant 层两个键)。

轨道按 (骨骼路径, 属性) 归并;骨骼路径哈希用 Avatar 的 m_TOS 反解。
输出 dict:
  {name, sampleRate, stopTime, tracks: [{path, attr, times[], values[]}]}
attr: 'position'(3) / 'rotation'(4, x,y,z,w) / 'scale'(3)
"""
import struct

ATTR_DIM = {1: 3, 2: 4, 3: 3}
ATTR_NAME = {1: 'position', 2: 'rotation', 3: 'scale'}


def _parse_streamed_frames(data_u32):
    """StreamedClip.Data → [(time, [(curveIdx, coefX, coefY, coefZ, value), ...])]"""
    raw = struct.pack('<%dI' % len(data_u32), *data_u32)
    n = len(raw)
    frames = []
    off = 0
    while off < n:
        time = struct.unpack_from('<f', raw, off)[0]
        off += 4
        count = struct.unpack_from('<i', raw, off)[0]
        off += 4
        if count < 0 or off + count * 20 > n:
            raise ValueError('streamed frame 越界: count=%d off=%d/%d' % (count, off, n))
        entries = []
        for _ in range(count):
            idx = struct.unpack_from('<i', raw, off)[0]
            cx, cy, cz = struct.unpack_from('<3f', raw, off + 4)
            val = struct.unpack_from('<f', raw, off + 16)[0]
            entries.append((idx, cx, cy, cz, val))
            off += 20
        frames.append((time, entries))
    return frames


def _hermite_sample(keys, rate):
    """streamed 单曲线 [(t, v, cx, cy, cz)] → [(t, v)] 线性重采样。

    运行时求值: v(t0+dt) = v0 + dt*cz + dt²*cx + dt³*cy。
    首帧(time=float.MinValue)只承载 PPtr,丢弃。
    """
    real = sorted((k for k in keys if k[0] > -1e30), key=lambda k: k[0])
    if not real:
        return []
    out = []
    t0, v0 = real[0][0], real[0][1]
    out.append((t0, v0))
    for nxt in real[1:]:
        t1, v1, cx, cy, cz = nxt
        dt = t1 - t0
        if dt <= 0:
            out.append((t1, v1))
            t0, v0 = t1, v1
            continue
        cubic = (cx != 0.0 or cy != 0.0)
        steps = max(1, int(round(rate * dt)))
        for s in range(1, steps):
            d = dt * s / steps
            if cubic:
                out.append((t0 + d, v0 + d * cz + d * d * cx + d * d * d * cy))
            else:
                out.append((t0 + d, v0 + (v1 - v0) * d / dt))
        out.append((t1, v1))
        t0, v0 = t1, v1
    return out


def _eval_linear(samples, t):
    if not samples:
        return 0.0
    lo, hi = 0, len(samples) - 1
    if t <= samples[0][0]:
        return samples[0][1]
    if t >= samples[hi][0]:
        return samples[hi][1]
    while lo <= hi:
        mid = (lo + hi) // 2
        tm = samples[mid][0]
        if abs(tm - t) < 1e-6:
            return samples[mid][1]
        if tm < t:
            lo = mid + 1
        else:
            hi = mid - 1
    a, b = samples[hi], samples[lo]
    f = (t - a[0]) / (b[0] - a[0])
    return a[1] + (b[1] - a[1]) * f


def decode_clip(tt, tos_map, oversample=2):
    """tt = AnimationClip.read_typetree(); tos_map = {hash:int -> bonePath}"""
    gb = tt['m_ClipBindingConstant']['genericBindings']
    mc = tt['m_MuscleClip']
    clip = mc['m_Clip']['data']
    st = clip['m_StreamedClip']
    de = clip['m_DenseClip']
    const = clip['m_ConstantClip']['data']
    rate = float(tt.get('m_SampleRate') or 30.0)
    stop = float(mc.get('m_StopTime') or 0.0)

    dims = [ATTR_DIM.get(g['attribute'], 1) for g in gb]
    base = []
    acc = 0
    for d in dims:
        base.append(acc)
        acc += d
    total = acc

    # 每个展开曲线分量的采样表
    comp_samples = [[] for _ in range(total)]

    # 1) streamed
    streamed_curve_count = int(st.get('curveCount') or 0)
    per_curve = {}
    for time, entries in _parse_streamed_frames(st['data']):
        if time <= -1e30:
            continue
        for idx, cx, cy, cz, val in entries:
            per_curve.setdefault(idx, []).append((time, val, cx, cy, cz))
    for idx, keys in per_curve.items():
        if not (0 <= idx < total):
            continue
        comp_samples[idx] = [(t, v) for t, v in _hermite_sample(keys, rate * oversample)]

    # 2) dense
    dense_count = int(de['m_CurveCount'])
    frame_count = int(de['m_FrameCount'])
    arr = de['m_SampleArray']
    begin = float(de.get('m_BeginTime') or 0.0)
    drate = float(de.get('m_SampleRate') or rate)
    for f in range(frame_count):
        t = begin + f / drate
        row = arr[f * dense_count:(f + 1) * dense_count]
        for c in range(dense_count):
            ci = streamed_curve_count + c
            if ci < total:
                comp_samples[ci].append((t, row[c]))

    # 3) constant(两个键;AssetRipper ProcessConstant 语义)
    pre_const = streamed_curve_count + dense_count
    off = 0
    ci = pre_const
    bi = None
    # 展开索引 → 绑定: 用 base 数组反查
    def binding_at(idx):
        # base 单调递增,线性找;绑定数少,够用
        for k in range(len(base) - 1, -1, -1):
            if base[k] <= idx:
                return k, idx - base[k]
        return None, 0
    while off < len(const) and ci < total:
        k, _ = binding_at(ci)
        d = dims[k]
        vals = const[off:off + d]
        if len(vals) < d:
            break
        for j, v in enumerate(vals):
            comp_samples[ci + j].append((0.0, v))
            if stop > 0:
                comp_samples[ci + j].append((stop, v))
        off += d
        ci += d

    # 归并到 (path, attr) 轨道
    tracks = {}
    for bi, g in enumerate(gb):
        attr = g['attribute']
        if attr not in ATTR_DIM:
            continue
        d = dims[bi]
        comps = comp_samples[base[bi]:base[bi] + d]
        if not any(comps):
            continue
        path_hash = g['path'] & 0xFFFFFFFF
        path = tos_map.get(path_hash, 'hash_%08x' % path_hash)
        times = sorted(set(t for c in comps for t, _ in c))
        values = []
        for t in times:
            for c in comps:
                values.append(_eval_linear(c, t))
        tracks[(path, ATTR_NAME[attr])] = {
            'path': path, 'attr': ATTR_NAME[attr], 'times': times, 'values': values}
    return {'name': tt.get('m_Name', ''), 'sampleRate': rate,
            'stopTime': stop, 'tracks': list(tracks.values())}


def tos_from_avatar(avatar_typetree):
    """Avatar.m_TOS(列表或字典)→ {hash:int -> path:str}"""
    tos = avatar_typetree['m_TOS']
    m = {}
    if isinstance(tos, list):
        for k, v in tos:
            m[int(k) & 0xFFFFFFFF] = v
    else:
        for k, v in tos.items():
            m[int(k) & 0xFFFFFFFF] = v
    return m
