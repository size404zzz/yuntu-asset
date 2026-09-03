/* avg-recorder.js - runtime AVG ground-truth recorder for Frida.
 *
 * This agent is deliberately read-only.  It enters the xLua VM through the
 * already exported lua_pcall/luaL_loadbufferx pair, wraps the Game.Avg Lua
 * methods, and emits JSON records.  The static AvgCfg tells us what the
 * author requested; this file records what the running client actually
 * resolved and sent to Unity/DOTween.
 */
'use strict';

const XLUA = 'libxlua.so';
const TARGETS = {
  PlayAvgAct: 1, PlayAvgActSG: 1, PlayAvgOrder: 1,
  RefreshAvgImg: 1, RefreshHeroFace: 1, RefreshAvgImgTween: 1,
  InitAvgHeroPic: 1, InitAvgHeroPicParam: 1, LoadHeroPic: 1,
  InitAvgImgItem: 1, InitAvgImgParam: 1, LoadTexture: 1, LoadMovie: 1,
  AddAvgImgTween: 1, PlayAvgImgTween: 1, AvgImgTweenDoComplete: 1,
  AvgImgTweenDoEnd: 1, OnTweenComplete: 1, SetAvgImgSequence: 1,
  GetAvgHeroPicResetData: 1, ChangeAvgImgOrder: 1, Delete: 1,
  AvgHeroChangeFace: 1, AvgHeroDissolveTween: 1,
  __ShowCommunication: 1, __ShowRipple: 1,
  PlayAvgEffect: 1, InitAvgEffectItem: 1, StopAvgEffect: 1,
  ChangeAvgPP: 1, InitAvgPP: 1, EndAvgPPV: 1,
  PlayAvgVideo: 1, PlayAvgVideoLoop: 1, StopAvgVideoLoop: 1,
  ShowAvgChapter: 1, ShowAvgDialog: 1, ShowAvgChoose: 1,
  ShowAvgContent: 1, OnChapterTextTweenComplete: 1,
};

/* Methods which are useful even when the module is loaded after the first
 * AVG call.  The Lua wrapper emits their before/after records explicitly; the
 * native layer uses the call hint to bind returned prefab roots. */

function findExport(mod, sym) {
  try {
    const m = Process.getModuleByName(mod);
    const a = m.findExportByName && m.findExportByName(sym);
    if (a && !a.isNull()) return a;
  } catch (_) {}
  try {
    const a = Module.findExportByName && Module.findExportByName(mod, sym);
    if (a && !a.isNull()) return a;
  } catch (_) {}
  return null;
}

const API = {};
['lua_pcall', 'luaL_loadbufferx', 'lua_settop', 'lua_pushcclosure',
  'lua_setglobal', 'lua_tolstring'].forEach((s) => { API[s] = findExport(XLUA, s); });
const missing = () => Object.keys(API).filter((k) => !API[k]);
let L = null;
let installed = false;
let emitCbRef = null;
let emitLenPtr = null;

/*
 * The Lua layer tells us what the script requested.  The visible result is
 * written by Unity/IL2CPP and DOTween afterwards, so a Lua-only recorder
 * cannot see breathing, shake, material dissolve or a recycled communication
 * item.  nativeTrace observes those writes at the Unity boundary.  It is
 * deliberately read-only: no managed value is changed and no tween is
 * replaced.
 *
 * The target currently runs the 32-bit IL2CPP player.  Do not hard-code
 * addresses here: MethodInfo's first word is the generated method pointer and
 * remains relocatable across game launches/updates as long as the managed
 * type/method signature is present.
 */
const nativeTrace = {
  installed: false,
  recording: false,
  rate: 60,
  allObjects: false,
  seq: 0,
  frame: 0,
  startMs: 0,
  timer: null,
  hooks: [],
  transforms: new Map(),
  materials: new Map(),
  graphics: new Map(),
  roots: new Map(),
  pending: [],
  context: {story: null, actId: null, cfgPath: null},
  hint: null,
  api: {},
};

function nativeFindMethod(assembly, namespace, klass, name, paramCount) {
  try {
    const image = nativeTrace.api.images[assembly];
    if (!image) return null;
    const type = nativeTrace.api.classFromName(
        image, Memory.allocUtf8String(namespace), Memory.allocUtf8String(klass));
    if (type.isNull()) return null;
    const method = nativeTrace.api.classGetMethod(
        type, Memory.allocUtf8String(name), paramCount);
    if (method.isNull()) return null;
    const code = method.readPointer();
    if (code.isNull() || !Process.findModuleByAddress(code)) return null;
    return {method, code};
  } catch (_) {
    return null;
  }
}

function nativeString(value) {
  if (!value || value.isNull()) return null;
  try {
    /* Il2CppString is object header (8 bytes), length (u32), UTF-16 chars
       (x86 build).  The public string helpers are optional on some HybridCLR
       builds and several are exported as compatibility aliases, so the
       layout fallback is the reliable path here. */
    const length = value.add(8).readU32();
    if (length > 4096) return null;
    return value.add(12).readUtf16String(length);
  } catch (_) {
    try {
      const length = nativeTrace.api.stringLength(value);
      const chars = nativeTrace.api.stringChars(value);
      if (chars.isNull() || length > 4096) return null;
      return chars.readUtf16String(length);
    } catch (_) {
      return null;
    }
  }
}

function nativeUtf8(value) {
  if (!value || value.isNull()) return null;
  try { return value.readUtf8String(); } catch (_) { return null; }
}

function nativeCall(method, ret, args) {
  if (!method) return null;
  try {
    return new NativeFunction(method.code, ret, args.types)(...args.values);
  } catch (_) {
    return null;
  }
}

function nativeCallObject(method, object) {
  if (!method || !object || object.isNull()) return null;
  try {
    /* All instance IL2CPP methods carry MethodInfo* as the final argument. */
    return new NativeFunction(method.code, 'pointer', ['pointer', 'pointer'])
        (object, ptr(0));
  } catch (_) {
    return null;
  }
}

function nativeCallInt(method, object) {
  if (!method || !object || object.isNull()) return null;
  try {
    return new NativeFunction(method.code, 'int', ['pointer', 'pointer'])
        (object, ptr(0));
  } catch (_) {
    return null;
  }
}

function nativeObjectName(object) {
  return nativeString(nativeCallObject(nativeTrace.api.objectGetName, object));
}

function nativeTransformName(transform) {
  return nativeObjectName(transform) || '<transform>';
}

function nativeBinding(transform) {
  let current = transform;
  for (let i = 0; current && !current.isNull() && i < 12; i++) {
    const key = current.toString();
    const root = nativeTrace.roots.get(key);
    if (root !== undefined) return root;
    current = nativeCallObject(nativeTrace.api.transformGetParent, current);
  }
  return null;
}

function nativePath(transform) {
  const names = [];
  let current = transform;
  for (let i = 0; current && !current.isNull() && i < 12; i++) {
    names.push(nativeTransformName(current));
    current = nativeCallObject(nativeTrace.api.transformGetParent, current);
  }
  return names.reverse().join('/');
}

function nativeLooksAvg(info) {
  if (nativeTrace.allObjects) return true;
  const text = `${info.name || ''}/${info.path || ''}`;
  return /avg|hero|lpic|breathe|communication|comm|ripple|dissolve|dialog|chapter|choose|effect|foreground|distant|background|blackedge|video|rawimg|imgitem/i.test(text);
}

function nativeTransformInfo(transform) {
  const key = transform.toString();
  let info = nativeTrace.transforms.get(key);
  if (info) return info;
  info = {
    key,
    ptr: transform,
    name: nativeTransformName(transform),
    path: nativePath(transform),
    imgId: nativeBinding(transform),
    dirty: true,
    pos: null,
    rotation: null,
    scale: null,
    color: null,
    material: null,
    active: null,
    siblingIndex: null,
  };
  nativeTrace.transforms.set(key, info);
  return info;
}

function nativeRefreshInfo(info) {
  if (!info) return;
  /* A child can be registered before its AVG root is known. */
  if (info.imgId == null) info.imgId = nativeBinding(info.ptr);
  if (!info.path) info.path = nativePath(info.ptr);
}

function nativeFloat(word) {
  try {
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setUint32(0, word.toUInt32(), true);
    return view.getFloat32(0, true);
  } catch (_) {
    return NaN;
  }
}

function nativeVec3(pointer) {
  try {
    if (!pointer || pointer.isNull()) return null;
    return {x: pointer.readFloat(), y: pointer.add(4).readFloat(),
      z: pointer.add(8).readFloat()};
  } catch (_) {
    return null;
  }
}

function nativeRecord(kind, data) {
  if (!nativeTrace.recording) return;
  const row = {
    schema: 'yuntu-avg-runtime/v1',
    seq: ++nativeTrace.seq,
    kind,
    native: true,
    mono: nativeTrace.startMs
      ? (Date.now() - nativeTrace.startMs) / 1000 : 0,
    story: nativeTrace.context.story,
    actId: nativeTrace.context.actId,
    cfgPath: nativeTrace.context.cfgPath,
  };
  if (data && typeof data === 'object') Object.assign(row, data);
  send({type: 'record', line: JSON.stringify(row)});
}

function nativeSetContext(row) {
  if (!row || typeof row !== 'object') return;
  if (row.story != null) nativeTrace.context.story = row.story;
  if (row.actId != null) nativeTrace.context.actId = row.actId;
  if (row.cfgPath != null) nativeTrace.context.cfgPath = row.cfgPath;
  if (row.kind === 'call' && row.phase === 'before'
      && row.imgId != null) {
    nativeTrace.hint = {imgId: row.imgId, fn: row.fn, at: Date.now()};
  }
}

function nativeFlushFrame() {
  if (!nativeTrace.recording) return;
  const objects = [];
  for (const info of nativeTrace.transforms.values()) {
    nativeRefreshInfo(info);
    if (!info.dirty || !nativeLooksAvg(info)) continue;
    const value = {
      key: info.key, name: info.name, path: info.path,
      imgId: info.imgId, pos: info.pos, rotation: info.rotation,
      scale: info.scale, color: info.color, material: info.material,
      active: info.active, siblingIndex: info.siblingIndex,
    };
    objects.push(value);
    info.dirty = false;
  }
  const materials = [];
  for (const owner of nativeTrace.graphics.values()) {
    const material = nativeTrace.materials.get(owner.material);
    if (material?.binding == null && owner.transform) {
      material.binding = nativeBinding(owner.transform);
    }
  }
  for (const material of nativeTrace.materials.values()) {
    if (!material.dirty) continue;
    if (!nativeTrace.allObjects && material.binding == null
        && !/avg|hero|lpic|dissolve|ripple|communication|comm/i.test(
            material.name || '')) continue;
    materials.push({key: material.key, name: material.name,
      binding: material.binding, values: material.values});
    material.dirty = false;
  }
  const particles = nativeTrace.pending.splice(0);
  if (!objects.length && !materials.length && !particles.length) return;
  nativeRecord('frame', {
    frame: ++nativeTrace.frame,
    objects, materials, particles,
  });
}

function nativeContextFromLua(row) {
  nativeSetContext(row);
}

function nativeMaterialInfo(material) {
  if (!material || material.isNull()) return null;
  const key = material.toString();
  let info = nativeTrace.materials.get(key);
  if (info) return info;
  info = {key, ptr: material, name: nativeObjectName(material),
    binding: null, values: {}, dirty: true};
  nativeTrace.materials.set(key, info);
  return info;
}

function nativeInstallHook(method, callbacks) {
  if (!method) return false;
  try {
    nativeTrace.hooks.push(Interceptor.attach(method.code, callbacks));
    return true;
  } catch (_) {
    return false;
  }
}

function nativeBindFromInstantiation(object) {
  if (!object || object.isNull() || !nativeTrace.hint
      || Date.now() - nativeTrace.hint.at > 30000) return;
  if (!/LoadHeroPic|InitAvgHeroPic/.test(nativeTrace.hint.fn || '')) return;
  const transform = nativeCallObject(nativeTrace.api.gameObjectGetTransform, object);
  if (!transform || transform.isNull()) return;
  const name = nativeObjectName(object);
  const path = nativePath(transform);
  if (!nativeTrace.allObjects && !nativeLooksAvg({name, path})) return;
  const imgId = nativeTrace.hint.imgId;
  nativeTrace.roots.set(transform.toString(), imgId);
  nativeRecord('binding', {imgId, root: transform.toString(),
    name, path});
}

/* rate 0 = 完全关闭原生采样（只录 Lua）。原生层在 MuMu 上实测会把游戏在
   attach 后约 1 秒内打进 SIGSEGV / Il2CppExceptionWrapper，需要逃生口。 */
function clampRate(value) {
  const n = Number(value);
  if (n === 0) return 0;
  return Math.max(1, Math.min(120, n || 60));
}

function nativeStart(rate = nativeTrace.rate, allObjects = nativeTrace.allObjects) {
  nativeTrace.rate = clampRate(rate);
  nativeTrace.allObjects = allObjects === true;
  if (!nativeTrace.rate) {
    nativeRecord('native', {state: 'disabled'});
    return;
  }
  nativeTrace.recording = true;
  nativeTrace.seq = 0;
  nativeTrace.frame = 0;
  nativeTrace.startMs = Date.now();
  if (nativeTrace.timer) clearInterval(nativeTrace.timer);
  nativeTrace.timer = setInterval(nativeFlushFrame,
      Math.max(1, Math.round(1000 / nativeTrace.rate)));
  nativeRecord('native', {state: 'started', rate: nativeTrace.rate,
    allObjects: nativeTrace.allObjects, hooks: nativeTrace.hooks.length});
}

function nativeStop() {
  nativeFlushFrame();
  nativeTrace.recording = false;
  if (nativeTrace.timer) clearInterval(nativeTrace.timer);
  nativeTrace.timer = null;
}

function nativeSetup() {
  if (nativeTrace.installed) return nativeTrace.hooks.length;
  if (!clampRate(nativeTrace.rate)) return 0;
  let stage = 'start';
  try {
    stage = 'bind il2cpp exports';
    const il2cpp = Process.getModuleByName('libil2cpp.so');
    const exp = (name, ret, args) => {
      const address = il2cpp.findExportByName(name);
      return address ? new NativeFunction(address, ret, args) : null;
    };
    const domain = exp('il2cpp_domain_get', 'pointer', []);
    const assemblies = exp('il2cpp_domain_get_assemblies', 'pointer',
        ['pointer', 'pointer']);
    const assemblyImage = exp('il2cpp_assembly_get_image', 'pointer',
        ['pointer']);
    const imageName = exp('il2cpp_image_get_name', 'pointer', ['pointer']);
    nativeTrace.api.classFromName = exp('il2cpp_class_from_name', 'pointer',
        ['pointer', 'pointer', 'pointer']);
    nativeTrace.api.classGetMethod = exp('il2cpp_class_get_method_from_name',
        'pointer', ['pointer', 'pointer', 'int']);
    nativeTrace.api.classGetMethods = exp('il2cpp_class_get_methods',
        'pointer', ['pointer', 'pointer']);
    nativeTrace.api.methodGetName = exp('il2cpp_method_get_name',
        'pointer', ['pointer']);
    nativeTrace.api.methodGetParamCount = exp('il2cpp_method_get_param_count',
        'uint32', ['pointer']);
    nativeTrace.api.methodGetParam = exp('il2cpp_method_get_param',
        'pointer', ['pointer', 'uint32']);
    nativeTrace.api.typeGetName = exp('il2cpp_type_get_name',
        'pointer', ['pointer']);
    nativeTrace.api.stringLength = exp('il2cpp_string_length', 'uint32',
        ['pointer']);
    nativeTrace.api.stringChars = exp('il2cpp_string_chars', 'pointer',
        ['pointer']);
    if (!domain || !assemblies || !assemblyImage || !imageName
        || !nativeTrace.api.classFromName || !nativeTrace.api.classGetMethod
        || !nativeTrace.api.stringLength || !nativeTrace.api.stringChars) {
      return 0;
    }
    const count = Memory.alloc(4);
    const list = assemblies(domain(), count);
    stage = 'enumerate assemblies';
    nativeTrace.api.images = {};
    for (let i = 0, n = count.readU32(); i < n; i++) {
      const assembly = list.add(i * Process.pointerSize).readPointer();
      const image = assemblyImage(assembly);
      const imageNamePtr = imageName(image);
      const name = imageNamePtr && !imageNamePtr.isNull()
        ? imageNamePtr.readUtf8String() : null;
      if (name) nativeTrace.api.images[name] = image;
    }

    const method = (assembly, namespace, klass, name, count) => {
      stage = `resolve ${klass}.${name}/${count}`;
      const found = nativeFindMethod(assembly, namespace, klass, name, count);
      return found;
    };
    nativeTrace.api.objectGetName = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Object', 'get_name', 0);
    nativeTrace.api.objectSetName = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Object', 'set_name', 1);
    nativeTrace.api.objectInstantiate = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Object', 'Instantiate', 1);
    nativeTrace.api.gameObjectGetTransform = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'GameObject',
        'get_transform', 0);
    nativeTrace.api.gameObjectSetActive = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'GameObject',
        'SetActive', 1);
    nativeTrace.api.transformGetParent = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'get_parent', 0);
    nativeTrace.api.transformSetParent = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'SetParent', 1);
    nativeTrace.api.transformPosition = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'set_localPosition_Injected', 1);
    nativeTrace.api.transformScale = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'set_localScale_Injected', 1);
    nativeTrace.api.transformRotation = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'SetLocalEulerAngles_Injected', 2);
    nativeTrace.api.transformEuler = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'set_localEulerAngles', 1);
    nativeTrace.api.transformSibling = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Transform',
        'SetSiblingIndex', 1);
    nativeTrace.api.transformGetGameObject = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Component',
        'get_gameObject', 0);
    nativeTrace.api.componentGetTransform = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Component',
        'get_transform', 0);
    nativeTrace.api.gameObjectActive = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'GameObject',
        'get_activeInHierarchy', 0);
    nativeTrace.api.graphicColor = method(
        'UnityEngine.UI.dll', 'UnityEngine.UI', 'Graphic', 'set_color', 1);
    nativeTrace.api.graphicMaterial = method(
        'UnityEngine.UI.dll', 'UnityEngine.UI', 'Graphic',
        'set_material', 1);
    nativeTrace.api.materialSetFloatName = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Material',
        'SetFloat', 2);
    nativeTrace.api.materialSetFloatId = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Material',
        'SetFloat', 2);
    nativeTrace.api.materialSetTextureName = method(
        'UnityEngine.CoreModule.dll', 'UnityEngine', 'Material',
        'SetTexture', 2);
    nativeTrace.api.particlePlay = method(
        'UnityEngine.ParticleSystemModule.dll', 'UnityEngine',
        'ParticleSystem', 'Play', 0);
    nativeTrace.api.particleStop = method(
        'UnityEngine.ParticleSystemModule.dll', 'UnityEngine',
        'ParticleSystem', 'Stop', 0);

    /* Instantiate has generic and non-generic overloads.  The one-parameter
       resolver above is only a fallback; enumerate every overload and hook
       the native return so prefab roots created with a parent are bound too. */
    const objectClass = nativeTrace.api.classFromName(
        nativeTrace.api.images['UnityEngine.CoreModule.dll'],
        Memory.allocUtf8String('UnityEngine'), Memory.allocUtf8String('Object'));
    const objectIterator = Memory.alloc(4); objectIterator.writeU32(0);
    const instantiateCodes = new Set();
    if (objectClass && !objectClass.isNull() && nativeTrace.api.classGetMethods) {
      let objectMethod;
      while (!(objectMethod = nativeTrace.api.classGetMethods(
          objectClass, objectIterator)).isNull()) {
        const objectMethodName = nativeUtf8(nativeTrace.api.methodGetName(objectMethod));
        if (!objectMethodName || !/^(Instantiate|Internal_InstantiateSingle)/.test(
            objectMethodName)) continue;
        const code = objectMethod.readPointer();
        if (!code || code.isNull() || instantiateCodes.has(code.toString())) continue;
        instantiateCodes.add(code.toString());
        nativeInstallHook({method: objectMethod, code}, {
          onLeave(retval) {
            if (!nativeTrace.recording || !retval || retval.isNull()) return;
            nativeBindFromInstantiation(retval);
          },
        });
      }
    }

    nativeInstallHook(nativeTrace.api.transformPosition, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        info.pos = nativeVec3(args[1]); info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.transformScale, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        info.scale = nativeVec3(args[1]); info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.transformRotation, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        info.rotation = nativeVec3(args[1]); info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.transformEuler, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        /* x86 value-type ABI: Vector3 occupies the next three words. */
        info.rotation = {x: nativeFloat(args[1]), y: nativeFloat(args[2]),
          z: nativeFloat(args[3])};
        info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.transformSibling, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        info.siblingIndex = args[1].toInt32(); info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.transformSetParent, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const info = nativeTransformInfo(args[0]);
        if (args[1] && !args[1].isNull()) {
          const parent = nativeTransformInfo(args[1]);
          const bound = parent.imgId ?? nativeBinding(args[1]);
          if (bound != null) {
            nativeTrace.roots.set(info.key, bound);
            info.imgId = bound;
          }
        }
        info.path = nativePath(args[0]); info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.gameObjectSetActive, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const transform = nativeCallObject(
            nativeTrace.api.gameObjectGetTransform, args[0]);
        if (!transform || transform.isNull()) return;
        const info = nativeTransformInfo(transform);
        info.active = args[1].toUInt32() !== 0; info.dirty = true;
      },
    });
    nativeInstallHook(nativeTrace.api.objectSetName, {
      onEnter(args) {
        const name = nativeString(args[1]);
        if (!name) return;
        for (const info of nativeTrace.transforms.values()) {
          const go = nativeCallObject(nativeTrace.api.transformGetGameObject,
              info.ptr);
          if (go && go.toString() === args[0].toString()) {
            info.name = name; info.path = nativePath(info.ptr); info.dirty = true;
          }
        }
      },
    });
    /* If metadata enumeration was unavailable, retain the basic overload. */
    if (!instantiateCodes.size) nativeInstallHook(nativeTrace.api.objectInstantiate, {
      onLeave(retval) {
        if (!nativeTrace.recording || !retval || retval.isNull()) return;
        nativeBindFromInstantiation(retval);
      },
    });
    nativeInstallHook(nativeTrace.api.graphicMaterial, {
      onEnter(args) {
        if (!nativeTrace.recording || !args[1] || args[1].isNull()) return;
        const graphicTransform = nativeCallObject(
            nativeTrace.api.componentGetTransform, args[0]);
        const material = nativeMaterialInfo(args[1]);
        const owner = nativeTrace.graphics.get(args[0].toString())
            ?? {transform: graphicTransform, material: null};
        owner.material = material.key;
        nativeTrace.graphics.set(args[0].toString(), owner);
        material.binding = nativeBinding(graphicTransform);
        material.dirty = true;
        const info = graphicTransform && !graphicTransform.isNull()
          ? nativeTransformInfo(graphicTransform) : null;
        if (info) { info.material = material.key; info.dirty = true; }
      },
    });
    nativeInstallHook(nativeTrace.api.graphicColor, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const transform = nativeCallObject(
            nativeTrace.api.componentGetTransform, args[0]);
        if (!transform || transform.isNull()) return;
        const info = nativeTransformInfo(transform);
        info.color = {r: nativeFloat(args[1]), g: nativeFloat(args[2]),
          b: nativeFloat(args[3]), a: nativeFloat(args[4])};
        info.dirty = true;
      },
    });
    const setFloat = (method, propertyIsName) => nativeInstallHook(method, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const material = nativeMaterialInfo(args[0]);
        const property = propertyIsName ? nativeString(args[1])
          : `#${args[1].toInt32()}`;
        material.values[property || '<unknown>'] = nativeFloat(args[2]);
        material.dirty = true;
      },
    });
    /* Both overloads have two managed parameters; resolve the overload by
       inspecting the parameter type rather than relying on method count. */
    stage = 'enumerate Material.SetFloat overloads';
    if (!nativeTrace.api.images['UnityEngine.CoreModule.dll']) {
      throw new Error('UnityEngine.CoreModule.dll image not found');
    }
    const materialClass = nativeTrace.api.classFromName(
        nativeTrace.api.images['UnityEngine.CoreModule.dll'],
        Memory.allocUtf8String('UnityEngine'), Memory.allocUtf8String('Material'));
    if (!materialClass || materialClass.isNull()) {
      throw new Error('Material class not found');
    }
    const iterator = Memory.alloc(4); iterator.writeU32(0);
    let floatMethods = [];
    while (materialClass && !materialClass.isNull()
        && nativeTrace.api.classGetMethods && nativeTrace.api.methodGetName
        && nativeTrace.api.methodGetParamCount && nativeTrace.api.methodGetParam
        && nativeTrace.api.typeGetName) {
      const method = nativeTrace.api.classGetMethods(materialClass, iterator);
      if (!method || method.isNull()) break;
      const code = method.readPointer();
      stage = 'read Material method metadata';
      const name = nativeUtf8(nativeTrace.api.methodGetName(method));
      if (name === 'SetFloat' && code && !code.isNull()
          && nativeTrace.api.methodGetParamCount(method) === 2) {
        const type = nativeUtf8(nativeTrace.api.typeGetName(
            nativeTrace.api.methodGetParam(method, 0)));
        floatMethods.push({method, code, propertyIsName: type === 'System.String'});
      }
    }
    for (const floatMethod of floatMethods) {
      if (floatMethod.propertyIsName) nativeInstallHook(floatMethod, {onEnter(args) {
        if (!nativeTrace.recording) return;
        const material = nativeMaterialInfo(args[0]);
        const property = nativeString(args[1]);
        if (!property) return;
        material.values[property] = nativeFloat(args[2]); material.dirty = true;
      }});
      else nativeInstallHook(floatMethod, {onEnter(args) {
        if (!nativeTrace.recording) return;
        const material = nativeMaterialInfo(args[0]);
        material.values[`#${args[1].toInt32()}`] = nativeFloat(args[2]);
        material.dirty = true;
      }});
    }
    nativeInstallHook(nativeTrace.api.particlePlay, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const transform = nativeCallObject(nativeTrace.api.componentGetTransform,
            args[0]);
        const info = nativeTransformInfo(transform || args[0]);
        if (nativeLooksAvg(info)) nativeTrace.pending.push({action: 'play',
          path: info.path, name: info.name, imgId: info.imgId});
      },
    });
    nativeInstallHook(nativeTrace.api.particleStop, {
      onEnter(args) {
        if (!nativeTrace.recording) return;
        const transform = nativeCallObject(nativeTrace.api.componentGetTransform,
            args[0]);
        const info = nativeTransformInfo(transform || args[0]);
        if (nativeLooksAvg(info)) nativeTrace.pending.push({action: 'stop',
          path: info.path, name: info.name, imgId: info.imgId});
      },
    });
    stage = 'complete';
    nativeTrace.installed = true;
    return nativeTrace.hooks.length;
  } catch (error) {
    send({type: 'info', msg: `native trace unavailable at ${stage}: ${error}`});
    return 0;
  }
}

let fnPcall, fnLoad, fnSettop, fnPushclosure, fnSetglobal, fnTolstring;
function bindApi() {
  fnPcall = new NativeFunction(API.lua_pcall, 'int',
      ['pointer', 'int', 'int', 'int']);
  fnLoad = new NativeFunction(API.luaL_loadbufferx, 'int',
      ['pointer', 'pointer', 'int', 'pointer', 'pointer']);
  fnSettop = new NativeFunction(API.lua_settop, 'void', ['pointer', 'int']);
  fnPushclosure = new NativeFunction(API.lua_pushcclosure, 'void',
      ['pointer', 'pointer', 'int']);
  fnSetglobal = new NativeFunction(API.lua_setglobal, 'void',
      ['pointer', 'pointer']);
  fnTolstring = new NativeFunction(API.lua_tolstring, 'pointer',
      ['pointer', 'int', 'pointer']);
}

function runLua(code) {
  const buf = Memory.allocUtf8String(code);
  const name = Memory.allocUtf8String('yuntu-avg-recorder');
  let rc = fnLoad(L, buf, code.length, name, ptr(0));
  if (rc !== 0) {
    const e = fnTolstring(L, -1, ptr(0));
    const msg = e.isNull() ? `load error ${rc}` : e.readUtf8String();
    fnSettop(L, -2);
    return {ok: false, error: msg};
  }
  rc = fnPcall(L, 0, 0, 0);
  if (rc !== 0) {
    const e = fnTolstring(L, -1, ptr(0));
    const msg = e.isNull() ? `runtime error ${rc}` : e.readUtf8String();
    fnSettop(L, -2);
    return {ok: false, error: msg};
  }
  return {ok: true};
}

function installBridge() {
  emitLenPtr = Memory.alloc(8);
  emitCbRef = new NativeCallback((state) => {
    emitLenPtr.writeInt(0);
    const s = fnTolstring(state, 1, emitLenPtr);
    let line = '<nil>';
    if (!s.isNull()) {
      try { line = s.readUtf8String(); } catch (_) { line = '<bad utf8>'; }
    }
    try {
      const row = JSON.parse(line);
      if (row && row.schema === 'yuntu-avg-runtime/v1') {
        nativeSetContext(row);
      }
    } catch (_) {}
    send({type: 'record', line});
    return 0;
  }, 'int', ['pointer']);
  fnPushclosure(L, emitCbRef, 0);
  fnSetglobal(L, Memory.allocUtf8String('__yuntu_avg_emit'));
}

/* Lua code is kept here, instead of using a generic object dump, because a
 * live UINAvgHeroPic contains circular references to UIAVGSystem, pools and
 * callbacks.  Config tables are finite and are serialized without a field
 * whitelist; live Unity userdata becomes a compact, useful descriptor. */
const BOOTSTRAP = String.raw`
local function emit(s)
  local f = __yuntu_avg_emit
  if f then f(s) end
end

_YAVG = _YAVG or {}
_YAVG.orig = _YAVG.orig or {}
_YAVG.wrapped = _YAVG.wrapped or {}
_YAVG.seq = _YAVG.seq or 0
_YAVG.recording = false
_YAVG.targets = {
  PlayAvgAct=true, PlayAvgActSG=true, PlayAvgOrder=true,
  RefreshAvgImg=true, RefreshHeroFace=true, RefreshAvgImgTween=true,
  InitAvgHeroPic=true, InitAvgHeroPicParam=true, LoadHeroPic=true,
  InitAvgImgItem=true, InitAvgImgParam=true, LoadTexture=true, LoadMovie=true,
  AddAvgImgTween=true, PlayAvgImgTween=true, AvgImgTweenDoComplete=true,
  AvgImgTweenDoEnd=true, OnTweenComplete=true, SetAvgImgSequence=true,
  GetAvgHeroPicResetData=true, ChangeAvgImgOrder=true, Delete=true,
  AvgHeroChangeFace=true, AvgHeroDissolveTween=true,
  __ShowCommunication=true, __ShowRipple=true,
  PlayAvgEffect=true, InitAvgEffectItem=true, StopAvgEffect=true,
  ChangeAvgPP=true, InitAvgPP=true, EndAvgPPV=true,
  PlayAvgVideo=true, PlayAvgVideoLoop=true, StopAvgVideoLoop=true,
  ShowAvgChapter=true, ShowAvgDialog=true, ShowAvgChoose=true,
  ShowAvgContent=true, OnChapterTextTweenComplete=true,
}

local function q(s)
  s = tostring(s)
  s = s:gsub('\\', '\\\\')
       :gsub('"', '\\"')
       :gsub('\n', '\\n')
       :gsub('\r', '\\r')
       :gsub('\t', '\\t')
  s = s:gsub('[%z\1-\31]', function(c)
    return string.format('\\u%04x', string.byte(c))
  end)
  return '"' .. s .. '"'
end

local function get(o, k)
  if o == nil then return nil end
  local ok, v = pcall(function() return o[k] end)
  return ok and v or nil
end

local function num(v)
  return type(v) == 'number' and v or tonumber(v)
end

local function vec(v)
  if v == nil then return nil end
  local x, y, z
  pcall(function()
    x, y, z = v.x, v.y, v.z
  end)
  if x == nil and type(v) == 'table' then
    x, y, z = v[1], v[2], v[3]
  end
  x, y, z = num(x), num(y), num(z)
  if x == nil or y == nil then return nil end
  return {x=x, y=y, z=z or 0}
end

local function ud(v)
  local text = '?'
  pcall(function() text = tostring(v) end)
  local v3 = vec(v)
  if v3 then return {__userdata=text, x=v3.x, y=v3.y, z=v3.z} end
  return {__userdata=text}
end

local function json(v, depth, seen)
  local t = type(v)
  if v == nil then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    return string.format('%.17g', v)
  end
  if t == 'string' then return q(v) end
  if t == 'function' or t == 'thread' then return 'null' end
  if t == 'userdata' then return json(ud(v), (depth or 0) + 1, seen) end
  if t ~= 'table' then return q(tostring(v)) end
  depth = depth or 0
  if depth > 14 then return '{"__truncated":true}' end
  seen = seen or {}
  if seen[v] then return '{"__cycle":true}' end
  seen[v] = true
  local n, array = #v, true
  local count = 0
  for k in pairs(v) do
    count = count + 1
    if type(k) ~= 'number' or k < 1 or k ~= math.floor(k) or k > n then
      array = false
    end
  end
  local out = {}
  if array then
    for i = 1, n do out[#out + 1] = json(v[i], depth + 1, seen) end
    seen[v] = nil
    return '[' .. table.concat(out, ',') .. ']'
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  for _, k in ipairs(keys) do
    local value = v[k]
    local vt = type(value)
    if vt ~= 'function' and vt ~= 'thread' then
      out[#out + 1] = q(k) .. ':' .. json(value, depth + 1, seen)
    end
  end
  seen[v] = nil
  return '{' .. table.concat(out, ',') .. '}'
end

local function ctx(self)
  local c = get(self, 'avgCtrl')
  if c == nil then c = get(self, 'avgSystem') end
  local story = get(c, 'chapterName')
  if story == nil then story = get(self, 'chapterName') end
  local act = get(c, 'curActId')
  if act == nil then act = get(self, 'curActId') end
  local path = get(c, 'avgCfgPath')
  return {story=story, actId=act, cfgPath=path}
end

local function target(self)
  if type(self) ~= 'table' then return nil end
  local out = {imgId=get(self, 'imgId'), faceId=get(self, 'faceId'),
    imgCfg=get(self, 'imgCfg')}
  local pic = get(self, 'picGo')
  if pic ~= nil then out.pic=tostring(get(pic, 'name') or pic) end
  local tr = get(self, 'transform')
  if tr ~= nil then
    out.transform={position=vec(get(tr, 'localPosition')),
      rotation=vec(get(tr, 'localEulerAngles')),
      scale=vec(get(tr, 'localScale')),
      siblingIndex=get(tr, 'siblingIndex')}
  end
  local ui = get(self, 'ui')
  local raw = get(ui, 'rawImg')
  if raw ~= nil then
    local color = get(raw, 'color')
    out.raw={color={r=get(color,'r'),g=get(color,'g'),b=get(color,'b'),a=get(color,'a')},
      enabled=get(raw, 'enabled')}
  end
  out.communication=get(self, 'commItem') ~= nil
  out.ripple=get(self, 'rippleMat') ~= nil or get(self, '_rippleMat') ~= nil
  out.dissolve=get(self, 'dissolveEffectGo') ~= nil
  return out
end

local function resetData(self, posId)
  if type(self) ~= 'table' or posId == nil then return nil end
  local f = get(self, 'GetAvgHeroPicResetData')
  if type(f) ~= 'function' then return nil end
  local ok, v = pcall(f, self, posId)
  if not ok or v == nil then return nil end
  return {pos=vec(get(v,'pos')), scale=vec(get(v,'scale')),
    alpha=get(v,'alpha')}
end

local function effectiveOps(self, cfg)
  if type(cfg) ~= 'table' then return {} end
  local c = ctx(self)
  local typ = get(self, 'GetAvgImgType')
  if type(typ) == 'function' then
    local ok, v = pcall(typ, self)
    if ok then typ = v else typ = nil end
  end
  local reset = nil
  if cfg.posId ~= nil and typ == 3 then reset = resetData(self, cfg.posId) end
  local pos = reset and reset.pos or vec(cfg.pos)
  local scale = reset and reset.scale or vec(cfg.scale)
  local ops = {}
  local duration, delay = cfg.duration or 0, cfg.delay or 0
  if pos then ops[#ops+1] = {op='localMove', delay=delay, duration=duration, to=pos} end
  if cfg.rot ~= nil then
    ops[#ops+1] = {op='localRotate', delay=delay, duration=duration,
      to=vec(cfg.rot), mode='FastBeyond360'}
  end
  if scale then ops[#ops+1] = {op='scale', delay=delay, duration=duration, to=scale} end
  if cfg.alpha ~= nil then
    ops[#ops+1] = {op='alpha', delay=delay, duration=duration, to=cfg.alpha}
  end
  if cfg.isDark ~= nil then
    ops[#ops+1] = {op='rgb', delay=delay, duration=duration,
      to=cfg.isDark and 0.5 or 1}
  end
  if cfg.shake ~= nil then
    local si = cfg.shakeIntensity or 1
    ops[#ops+1] = {op='shake', delay=delay, duration=duration,
      amplitude={x=10*si,y=10*si,z=0}, vibrato=20*si}
  end
  if cfg.dissolve ~= nil then
    ops[#ops+1] = {op='dissolve', delay=delay, duration=duration,
      value=0.55, ease='OutQuart'}
  end
  return ops
end

local function record(kind, self, data)
  if not _YAVG.recording then return end
  _YAVG.seq = _YAVG.seq + 1
  local c = ctx(self)
  local row = {schema='yuntu-avg-runtime/v1', seq=_YAVG.seq, kind=kind,
    story=c.story, actId=c.actId, cfgPath=c.cfgPath}
  if type(data) == 'table' then
    for k, v in pairs(data) do row[k] = v end
  end
  emit(json(row))
end

local function argsAfterSelf(args)
  local out = {}
  for i = 2, #args do out[#out + 1] = args[i] end
  return out
end

local function instrument(label, key, fn, tbl)
  if type(fn) ~= 'function' or _YAVG.wrapped[label] then return end
  _YAVG.wrapped[label] = true
  _YAVG.orig[label] = fn
  tbl[key] = function(...)
    local args = {...}
    local self = args[1]
    if key == 'InitAvgHeroPic' or key == 'LoadHeroPic'
        or key == 'InitAvgImgItem' or key == 'InitAvgImgParam'
        or key == 'PlayAvgEffect' or key == 'InitAvgEffectItem'
        or key == 'ChangeAvgPP' or key == 'InitAvgPP' then
      record('call', self, {phase='before', fn=label,
        imgId=get(self, 'imgId'), args=argsAfterSelf(args)})
    end
    local before, after
    if key == 'AddAvgImgTween' or key == 'PlayAvgImgTween'
        or key == 'Tween' or key == 'AvgHeroDissolveTween'
        or key == 'AvgHeroChangeFace' or key == '__ShowCommunication'
        or key == '__ShowRipple' or key == 'InitAvgHeroPicParam'
        or key == 'InitAvgImgParam' then
      before = target(self)
    end
    local ok, result = pcall(function()
      return table.pack(fn(table.unpack(args, 1, #args)))
    end)
    if not ok then
      record('error', self, {fn=label, error=tostring(result)})
      error(result, 0)
    end
    after = target(self)
    local extra = {fn=label, args=argsAfterSelf(args), before=before, after=after}
    if key == 'PlayAvgAct' then
      extra.actCfg=get(self, 'actCfg')
      extra.avgCfgPath=get(self, 'avgCtrl') and get(get(self,'avgCtrl'),'avgCfgPath')
      record('act', self, extra)
    elseif key == 'RefreshAvgImg' then
      extra.images=args[2]
      record('images', self, extra)
    elseif key == 'RefreshHeroFace' then
      extra.faces=args[2]
      record('faces', self, extra)
    elseif key == 'AddAvgImgTween' or key == 'PlayAvgImgTween' or key == 'Tween' then
      local cfg = args[2]
      extra.cfg=cfg
      extra.ops=effectiveOps(self, cfg)
      record('tween', self, extra)
    elseif key == 'GetAvgHeroPicResetData' then
      extra.posId=args[2]
      extra.reset=result[1]
      record('reset', self, extra)
    elseif key == 'AvgHeroChangeFace' then
      extra.faceId=args[2]
      record('face', self, extra)
    elseif key == 'AvgHeroDissolveTween' then
      extra.duration=args[2]
      record('dissolve', self, extra)
    elseif key == '__ShowCommunication' then
      extra.show=args[2]
      record('communication', self, extra)
    elseif key == '__ShowRipple' then
      extra.show=args[2]
      record('ripple', self, extra)
    elseif key == 'PlayAvgEffect' or key == 'InitAvgEffectItem'
        or key == 'StopAvgEffect' then
      extra.config=args[2]
      record('effect', self, extra)
    elseif key == 'ChangeAvgPP' or key == 'InitAvgPP' or key == 'EndAvgPPV' then
      extra.config=args[2]
      record('postProcess', self, extra)
    elseif key == 'PlayAvgVideo' or key == 'PlayAvgVideoLoop'
        or key == 'StopAvgVideoLoop' then
      record('video', self, extra)
    elseif key == 'ChangeAvgImgOrder' or key == 'Delete'
        or key == 'InitAvgHeroPic' or key == 'InitAvgImgItem'
        or key == 'LoadHeroPic' or key == 'LoadTexture' or key == 'LoadMovie' then
      record('lifecycle', self, extra)
    elseif key == 'SetAvgImgSequence' or key == 'OnTweenComplete'
        or key == 'AvgImgTweenDoComplete' or key == 'AvgImgTweenDoEnd' then
      record('completion', self, extra)
    elseif key == 'PlayAvgOrder' or key == 'RefreshAvgImgTween'
        or key == 'ShowAvgChapter' or key == 'ShowAvgDialog'
        or key == 'ShowAvgChoose' or key == 'ShowAvgContent'
        or key == 'OnChapterTextTweenComplete' then
      record('timeline', self, extra)
    end
    return table.unpack(result, 1, result.n)
  end
end

function _YAVG.install()
  local n = 0
  for name, m in pairs(package.loaded or {}) do
    if type(name) == 'string' and name:match('^Game%.Avg') and type(m) == 'table' then
      n = n + 1
      for k, v in pairs(m) do
        if _YAVG.targets[tostring(k)] then instrument(name .. '.' .. tostring(k), k, v, m) end
      end
      local mt = getmetatable(m)
      local ix = mt and get(mt, '__index')
      if type(ix) == 'table' and ix ~= m then
        for k, v in pairs(ix) do
          if _YAVG.targets[tostring(k)] then instrument(name .. ':meta.' .. tostring(k), k, v, ix) end
        end
      end
    end
  end
  return n
end

function _YAVG.start()
  _YAVG.recording = true
  _YAVG.install()
  record('recorder', nil, {state='started'})
end
function _YAVG.stop()
  record('recorder', nil, {state='stopped'})
  _YAVG.recording = false
end
function _YAVG.refresh() _YAVG.install() end
function _YAVG.stats()
  local n = 0
  for _ in pairs(_YAVG.wrapped) do n = n + 1 end
  record('recorder', nil, {state='stats', wrapped=n})
end
emit('{"schema":"yuntu-avg-runtime/v1","kind":"ready"}')
`;

function captureState() {
  return new Promise((resolve, reject) => {
    const target = API.lua_pcall;
    if (!target) return reject(new Error('lua_pcall export not found'));
    let done = false;
    const listener = Interceptor.attach(target, {
      onEnter(args) {
        if (done) return;
        done = true;
        L = args[0];
        listener.detach();
        send({type: 'info', msg: `captured lua_State ${L}`});
        resolve(L);
      },
    });
    setTimeout(() => { if (!done) reject(new Error('timeout waiting for lua_pcall')); }, 15000);
  });
}

function setup() {
  if (installed) return Promise.resolve({ok: true});
  const gaps = missing();
  if (gaps.length) return Promise.reject(new Error(`missing exports: ${gaps.join(',')}`));
  bindApi();
  return captureState().then(() => {
    installBridge();
    const nativeHooks = nativeSetup();
    send({type: 'info', msg: `native trace hooks=${nativeHooks}`});
    const result = runLua(BOOTSTRAP);
    if (!result.ok) throw new Error(`bootstrap failed: ${result.error}`);
    installed = true;
    return result;
  });
}

rpc.exports = {
  ping() { return {installed, state: L ? L.toString() : null, missing: missing(),
    native: {installed: nativeTrace.installed, hooks: nativeTrace.hooks.length,
      transforms: nativeTrace.transforms.size}}; },
  configure(rate, allObjects) {
    nativeTrace.rate = clampRate(rate);
    nativeTrace.allObjects = allObjects === true;
    return {rate: nativeTrace.rate, allObjects: nativeTrace.allObjects};
  },
  start() { return setup().then(() => {
    const result = runLua('_YAVG.start()');
    if (result.ok) nativeStart();
    return result;
  }); },
  stop() { return setup().then(() => {
    nativeStop();
    return runLua('_YAVG.stop()');
  }); },
  refresh() { return setup().then(() => runLua('_YAVG.refresh()')); },
  stats() { return setup().then(() => runLua('_YAVG.stats()')); },
  eval(code) { return setup().then(() => runLua(String(code))); },
};
