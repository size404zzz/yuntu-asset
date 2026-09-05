/* dyn-config-dump.js —— 从活体 xLua VM 里抓运行时配置表（Frida agent）。
 *
 * 与 avg-recorder.js 同一条只读通道：hook 一次 lua_pcall 拿到活的 lua_State*，
 * 之后用 luaL_loadbufferx + lua_pcall 在游戏自己的 VM 里跑我们的 Lua，把
 * ConfigData 里「静态表 + 动态下发合并后」的真值序列化成 JSON 行，
 * 经 __yuntu_avg_emit 桥 send 回宿主机。不修改任何游戏数据。
 *
 * 为什么要在活体里抓：build-story-archive 用的静态 TextAsset 里，handbook 的
 * class 3 content、anniversary24/carnival23/delivery 三张回顾表都是空的——
 * 游戏运行时从 CDN 拉动态配置（LoadDynCfg）后才填上；剧情树的这几个缺口
 * 只有活体里能看到。
 */
'use strict';

const XLUA = 'libxlua.so';

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
  /* code.length 是 UTF-16 单元数；Lua 块里有中文注释，必须按 UTF-8 字节数
     传，否则 loadbuffer 从中截断（avg-recorder 的 eval 带非 ASCII 会踩同坑）。 */
  let byteLen = 0;
  for (const ch of code) {
    const c = ch.codePointAt(0);
    byteLen += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  const name = Memory.allocUtf8String('yuntu-dyn-config-dump');
  let rc = fnLoad(L, buf, byteLen, name, ptr(0));
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
    send({type: 'record', line});
    return 0;
  }, 'int', ['pointer']);
  fnPushclosure(L, emitCbRef, 0);
  fnSetglobal(L, Memory.allocUtf8String('__yuntu_dyn_emit'));
}

/* JSON 编码器与 avg-recorder.js 的 BOOTSTRAP 同源（那边是局部量，这边要
 * 跨 eval 复用，挂到 _YDYN 全局上）。配置表是纯数据，userdata 只留描述。 */
const BOOTSTRAP = String.raw`
local function emit(s)
  local f = __yuntu_dyn_emit
  if f then f(s) end
end

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
  if t == 'userdata' then
    local text = '?'
    pcall(function() text = tostring(v) end)
    return q(text)
  end
  if t ~= 'table' then return q(tostring(v)) end
  depth = depth or 0
  if depth > 12 then return '{"__truncated":true}' end
  seen = seen or {}
  if seen[v] then return '{"__cycle":true}' end
  seen[v] = true
  local n, array = #v, true
  for k in pairs(v) do
    if type(k) ~= 'number' or k < 1 or k ~= math.floor(k) or k > n then
      array = false
      break
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
    out[#out + 1] = q(k) .. ':' .. json(v[k], depth + 1, seen)
  end
  seen[v] = nil
  return '{' .. table.concat(out, ',') .. '}'
end

_YDYN = _YDYN or {}
_YDYN.json = json

-- 一行一条目地回传一张表：key 是 Lua 顶层键（数字或字符串），importer 端
-- 按 key 重排（1..n 连续则还原成数组）。seq 保证宿主侧顺序可复核。
function _YDYN.dump(name, source, t)
  if t == nil or type(t) ~= 'table' then
    emit(json({schema = 'yuntu-dyn-config/v1', kind = 'table', name = name,
               source = source, missing = true}))
    return 0
  end
  local n = 0
  for k in pairs(t) do n = n + 1 end
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'table', name = name,
             source = source, count = n}))
  for k, v in pairs(t) do
    emit(json({schema = 'yuntu-dyn-config/v1', kind = 'row', name = name,
               source = source, key = k, v = v}))
  end
  return n
end

-- 分块版：一次性发千余条 send 会把目标进程冲垮（实测两次都死在 story_avg
-- 2160 行刚发完），宿主按小块轮询。prepare 固定键序（pairs 序不稳定），
-- chunk 按序号区间取，host 每块一次 rpc，间隔本身就是限速。
function _YDYN.prepare(name, source, t)
  if type(t) ~= 'table' then
    emit(json({schema = 'yuntu-dyn-config/v1', kind = 'table', name = name,
               source = source, missing = true}))
    return 0
  end
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  _YDYN.cur = {name = name, source = source, t = t, keys = keys}
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'table', name = name,
             source = source, count = #keys}))
  return #keys
end

function _YDYN.chunk(from, to)
  local cur = _YDYN.cur
  if not cur then return 0 end
  local f = from or 1
  local t = math.min(to or #cur.keys, #cur.keys)
  for i = f, t do
    local k = cur.keys[i]
    emit(json({schema = 'yuntu-dyn-config/v1', kind = 'row', name = cur.name,
               source = cur.source, key = k, v = cur.t[k]}))
  end
  return t - f + 1
end

-- 运行时环境一览：ConfigData 在不在、LoadDynCfg 签名长什么样、
-- eDynConfigData 有哪些槽（动态下发表的名字清单就藏在里面）。
function _YDYN.meta()
  local CD = rawget(_G, 'ConfigData')
  local E = rawget(_G, 'eDynConfigData')
  local slots = {}
  if type(E) == 'table' then
    for k in pairs(E) do slots[#slots + 1] = tostring(k) end
    table.sort(slots)
  end
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'meta',
             hasConfigData = type(CD) == 'table',
             loadDynCfg = type(CD) == 'table' and type(CD.LoadDynCfg) or nil,
             dynSlots = slots,
             xluaVersion = rawget(_G, '_VERSION')}))
end

-- 动态槽抓取。游戏侧用法（HandBookActReviewFunc f26 反汇编）：
--   ConfigData:LoadDynCfg(eDynConfigData[name])   -- 装载，返回值没人用
--   ConfigData[name][actId]                        -- 表落在 ConfigData[name]
--   ConfigData:ReleaseDynCfg(eDynConfigData[name]) -- 用完释放
-- 所以 LoadDynCfg 返回 nil 是正常的，抓的是 ConfigData[name]；dump 完释放。
function _YDYN.dumpDyn(name)
  local CD = rawget(_G, 'ConfigData')
  if type(CD) ~= 'table' or type(CD.LoadDynCfg) ~= 'function' then
    _YDYN.dump(name, 'dyncfg-missing-loader', nil)
    return
  end
  local slot = nil
  local okE, E = pcall(require, 'Game.ConfigData.eDynConfigData')
  if okE and type(E) == 'table' then
    local ok, v = pcall(function() return E[name] end)
    if ok then slot = v end
  end
  if slot == nil then
    _YDYN.dump(name, 'dyncfg-no-slot', nil)
    return
  end
  local okL = pcall(function() CD:LoadDynCfg(slot) end)
  if not okL then
    _YDYN.dump(name, 'dyncfg-load-error', nil)
    return
  end
  local ok, t = pcall(function() return CD[name] end)
  if ok and type(t) == 'table' then
    local n = _YDYN.prepare(name, 'dyncfg', t)
    for i = 1, n, 200 do _YDYN.chunk(i, i + 199) end
    pcall(function() CD:ReleaseDynCfg(slot) end)
  else
    _YDYN.dump(name, 'dyncfg-empty', nil)
  end
end

-- 静态合并真值：直接读 ConfigData[name]（运行时已是静态+动态合并后的样子）。
function _YDYN.dumpStatic(name)
  local CD = rawget(_G, 'ConfigData')
  if type(CD) ~= 'table' then
    _YDYN.dump(name, 'configdata-missing', nil)
    return
  end
  local ok, t = pcall(function() return CD[name] end)
  if not ok or type(t) ~= 'table' then
    _YDYN.dump(name, 'configdata-missing', nil)
    return
  end
  _YDYN.dump(name, 'configdata', t)
end
-- 全流程：分类表走 ConfigData 合并真值（分块 emit 防洪峰），其余走
-- LoadDynCfg。这个函数在 lua_pcall 钩子内部被调（见 JS 侧 armDump）——
-- 游戏线程此刻被拦截挂起，我们对 L 的操作天然与游戏串行，没有竞态。
function _YDYN.autoDump(names)
  _YDYN.meta()
  for _, name in ipairs(names) do
    local t = nil
    local ok, v = pcall(function() return ConfigData[name] end)
    if ok then t = v end
    if type(t) == 'table' then
      local n = _YDYN.prepare(name, 'configdata', t)
      for i = 1, n, 200 do _YDYN.chunk(i, i + 199) end
    else
      _YDYN.dumpDyn(name)
    end
  end
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'done'}))
end

-- 手册 content 按键直读版。content 表带 __index 惰性元表（pairs 数不到
-- 动态合并进来的行——实测 class 3 的 27 行 pairs=0、直读=27），所以成员
-- id 清单由宿主从静态档案传入，逐 id 直读行。
-- namesJson = '{"1":[9001,...],"3":[10001,...]}'（classId → 成员 actId）
function _YDYN.dumpHandbook(namesJson)
  local CD = ConfigData
  -- namesJson 是宿主拼好的 Lua 表字面量：{'1'={9001,...},'2'={...},'3'={...}}
  local members = namesJson
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'handbook-start'}))
  local hb = CD.handbook_activity
  if type(hb) ~= 'table' then
    emit(json({schema = 'yuntu-dyn-config/v1', kind = 'handbook-row',
               missing = true}))
    return
  end
  for _, cls in pairs(hb) do
    if type(cls) == 'table' then
      local cid = tostring(cls.id)
      local content = cls.content
      local want = {}
      local okm, m = pcall(function() return members[cid] end)
      if okm and type(m) == 'table' then
        for _, id in ipairs(m) do want[id] = true end
      end
      if type(content) == 'table' then
        for k in pairs(content) do want[k] = true end
      end
      local keys = {}
      for k in pairs(want) do keys[#keys + 1] = k end
      table.sort(keys, function(a, b) return (tonumber(a) or 0) < (tonumber(b) or 0) end)
      for _, id in ipairs(keys) do
        local okr, row = pcall(function() return content[id] end)
        emit(json({schema = 'yuntu-dyn-config/v1', kind = 'handbook-row',
                   classId = tonumber(cid) or cid, id = tonumber(id) or id,
                   row = okr and row or nil}))
      end
    end
  end
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'handbook-done'}))
end
-- 运行时剧情分类：直接调用 HandBookActReviewFunc[type](series)，把游戏自己
-- 算好的 CPRData（avgGroupList = 活动 → 剧情组 → AvgIdList）接住。ids 是
-- Lua 数组字面量。在钩子内执行（armClassify），无竞态。
function _YDYN.classify(ids)
  local RF = require('Game.HandBook.UI.Activity.HandBookActReviewFunc')
  local CD = ConfigData
  for _, actId in ipairs(ids) do
    local out = {schema = 'yuntu-dyn-config/v1', kind = 'classification', actId = actId}
    local row = CD.activity[actId] or CD.activity[tostring(actId)]
    if not row then
      out.error = 'no activity row'
    else
      out.type = row.type
      out.series = row.activity_id
      local proc = RF[row.type]
      if not proc then
        out.error = 'no processor for type ' .. tostring(row.type)
      else
        local ok, cpr = pcall(proc, row.activity_id)
        if not ok then
          out.error = tostring(cpr):sub(1, 120)
        elseif type(cpr) ~= 'table' then
          out.error = 'proc returned ' .. type(cpr)
        else
          out.total = cpr.totalNum4Show
          out.unlocked = cpr.totalUnlockedNum4Show
          local okG, groups = pcall(function() return cpr:GetCPRAvgGroupList() end)
          local gs = {}
          if okG and type(groups) == 'table' then
            for _, g in ipairs(groups) do
              local gOut = {name = g.groupName, en = g.groupENName, des = g.groupDes}
              local okI, idList = pcall(function() return g:GetAvgGroupAvgIdList() end)
              gOut.avgIds = okI and idList or nil
              gs[#gs + 1] = gOut
            end
          else
            out.groupErr = tostring(groups):sub(1, 100)
          end
          out.groups = gs
        end
      end
    end
    emit(json(out))
  end
  emit(json({schema = 'yuntu-dyn-config/v1', kind = 'classify-done'}))
end
-- AvgPlay 触发分类全表：ControllerManager:GetController(AvgPlay).triggerTypeDic
-- = [触发类型][place][参数1][参数2] → avgCfg（story_avg 行）。活体表会被游戏
-- 线程并发改写，pairs 中途会炸——必须在钩子内（游戏线程挂起时）遍历。
function _YDYN.dumpTriggers()
  local ctrl = ControllerManager:GetController(ControllerTypeId.AvgPlay)
  local dic = ctrl.triggerTypeDic
  local f = __yuntu_dyn_emit
  if type(dic) ~= 'table' then
    f('{"schema":"yuntu-dyn-config/v1","kind":"trig-done","missing":true}')
    return
  end
  local flat = {}
  local function walk(t, path, depth)
    if type(t) ~= 'table' then return end
    for k, v in pairs(t) do
      local p = {}
      for i = 1, #path do p[i] = path[i] end
      p[#p + 1] = tostring(k)
      if type(v) == 'table' and v.script_id == nil and depth < 6 then
        walk(v, p, depth + 1)
      else
        flat[#flat + 1] = {p, v}
      end
    end
  end
  for t, places in pairs(dic) do
    walk(places, {tostring(t)}, 1)
  end
  local rowsOut = {}
  for _, e in ipairs(flat) do
    local leaf = e[2]
    rowsOut[#rowsOut + 1] = json({
      schema = 'yuntu-dyn-config/v1', kind = 'trigger', path = e[1],
      avgId = type(leaf) == 'table' and leaf.id or nil,
      script = type(leaf) == 'table' and leaf.script_id or nil,
      sector = type(leaf) == 'table' and leaf.sectorId or nil,
      stage = type(leaf) == 'table' and leaf.set_place or nil,
      activity = type(leaf) == 'table' and leaf.activity_id or nil,
    })
  end
  local N = 8
  local per = math.ceil(math.max(1, #rowsOut) / N)
  for i = 1, N do
    local a = (i - 1) * per + 1
    local b = math.min(i * per, #rowsOut)
    local seg = {}
    for j = a, b do seg[#seg + 1] = rowsOut[j] end
    f(json({schema = 'yuntu-dyn-config/v1', kind = 'trig', part = i,
            total = #rowsOut, data = '[' .. table.concat(seg, ',') .. ']'}))
  end
  f(json({schema = 'yuntu-dyn-config/v1', kind = 'trig-done', total = #rowsOut}))
end
emit('{"schema":"yuntu-dyn-config/v1","kind":"ready"}')
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
    const result = runLua(BOOTSTRAP);
    if (!result.ok) throw new Error(`bootstrap failed: ${result.error}`);
    installed = true;
    return result;
  });
}

/* 在钩子内部跑 dump：拦下一次 lua_pcall（跳过前 50 次调用，避开开局的
 * 敏感窗口），在游戏线程被拦截的当口同步跑完全部序列化与 send。游戏线程
 * 挂起期间对 L 没有并发使用，根除「Frida 线程 vs 游戏线程同踩 L」的竞态
 * ——之前 eval 路线的偶发 access violation / 进程死亡都源于此。 */
let armed = false;
/* 钩子路径公共体：拦下一次 lua_pcall（跳过前 50 次，避开开局敏感窗口），
 * 在游戏线程被拦截的当口同步执行 chunk。 */
function armOnPcall(run) {
  const target = API.lua_pcall;
  let calls = 0;
  let fired = false;
  const listener = Interceptor.attach(target, {
    onEnter(args) {
      calls += 1;
      if (fired || calls < 50) return;
      fired = true;
      listener.detach();
      L = args[0];
      try {
        bindApi();
        installBridge();
        let r = runLua(BOOTSTRAP);
        if (!r.ok) { send({type: 'info', msg: `bootstrap failed: ${r.error}`}); return; }
        r = runLua(run);
        if (!r.ok) send({type: 'info', msg: `hook run failed: ${r.error}`});
      } catch (e) {
        send({type: 'info', msg: `dump exception: ${e}`});
      }
    },
  });
  return {ok: true, note: 'armed'};
}

function armDump(luaNames) {
  if (armed) return {ok: true, note: 'already armed'};
  armed = true;
  return armOnPcall(`_YDYN.autoDump(${luaNames})`);
}

function armClassify(luaIds) {
  if (armed) return {ok: true, note: 'already armed'};
  armed = true;
  return armOnPcall(`_YDYN.classify(${luaIds})`);
}

function armTriggers() {
  if (armed) return {ok: true, note: 'already armed'};
  armed = true;
  return armOnPcall(`_YDYN.dumpTriggers()`);
}

rpc.exports = {
  ping() { return {installed, state: L ? L.toString() : null, missing: missing()}; },
  eval(code) { return setup().then(() => runLua(String(code))); },
  handbook(namesLua) {
    return setup().then(() => runLua(`_YDYN.dumpHandbook(${namesLua})`));
  },
  dumpAll(namesJson) {
    // 名单来自宿主（表名是简单标识符，直接内插进 Lua 字面量；Lua 表用 {}）
    const names = JSON.parse(namesJson);
    const luaNames = '{' + names.map((n) => `'${String(n).replace(/'/g, "\\'")}'`).join(',') + '}';
    return setup().then(() => {
      if (installed && L) {
        // 已有活 L（meta 探针建立的会话）——直接跑也行，但为统一竞态安全
        // 仍走钩子路径：先丢掉旧 L。
        installed = false;
      }
      return armDump(luaNames);
    });
  },
  classifyAll(idsJson) {
    const ids = JSON.parse(idsJson);
    const luaIds = '{' + ids.map((n) => String(Number(n))).join(',') + '}';
    return setup().then(() => {
      installed = false;
      return armClassify(luaIds);
    });
  },
  armTriggers() {
    return setup().then(() => {
      installed = false;
      return armTriggers();
    });
  },
};
