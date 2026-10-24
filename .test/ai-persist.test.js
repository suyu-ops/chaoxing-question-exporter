// AI 设置弹窗交互回归：模拟「填表 → 保存 → 关弹窗 → 重开」完整往返。
// 目标：重现并防止「点了保存，再点进去又显示没配置」。
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { extractFunction, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
function brief(v) {
  const t = JSON.stringify(v);
  return t === undefined ? String(v) : (t.length > 140 ? t.slice(0, 140) + '…' : t);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${brief(expected)}\n   实际: ${brief(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 真实 localStorage 模拟（带配额）+ jsdom DOM ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;

const QUOTA = 5 * 1024 * 1024;
const map = new Map();
let used = 0;
const size = v => Buffer.byteLength(String(v), 'utf8');
global.localStorage = {
  getItem: k => (map.has(k) ? map.get(k) : null),
  setItem(k, v) {
    const old = map.has(k) ? size(map.get(k)) : 0;
    const next = used - old + size(v);
    if (next > QUOTA) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
    if (map.has(k)) map.delete(k);
    map.set(k, String(v));
    used = next;
  },
  removeItem(k) {
    if (!map.has(k)) return;
    used -= size(map.get(k));
    map.delete(k);
  }
};

// ---- 装配被测函数 ----
function build() {
  const parts = [
    'let __toastImpl = () => {};',
    'function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }',
    'const SETTINGS_KEY = "xxt_settings";',
    'const DEFAULT_SETTINGS = { theme:"auto", shortcut:{ctrl:true,shift:true,alt:false,key:"e"}, exportConfig:{format:"word",withAnswers:false,shuffle:false,bankImport:false}, enableDrag:true, rememberPanelPosition:true, panelPosition:null, floatingPositions:{}, bankThreshold:90, ai:{baseUrl:"",apiKey:"",model:"",models:[],concurrency:2,lastTestAt:"",lastTestOk:null} };'
  ];
  for (const name of ['normalizeAiSettings', 'loadSettings', 'saveSettings', 'describeSettingsStorage', 'xxtNormalizeAiBaseUrl']) {
    parts.push(extractFunction(src, name));
  }
  parts.push('let currentSettings = loadSettings();');
  parts.push('module.exports = { get: () => currentSettings, set: v => { currentSettings = v; }, saveSettings, loadSettings, describeSettingsStorage, xxtNormalizeAiBaseUrl, setToast: fn => { __toastImpl = fn; } };');
  const file = path.join(__dirname, '.build-ai-ui.js');
  fs.writeFileSync(file, parts.join('\n\n'));
  delete require.cache[require.resolve(file)];
  return require(file);
}

// ---- 模拟 AI 设置弹窗的保存逻辑（与主脚本 save() 一致）----
function simulateDialogSave(M, form) {
  const previousAi = { ...(M.get().ai || {}) };
  M.get().ai = {
    baseUrl: M.xxtNormalizeAiBaseUrl(form.baseUrl),
    apiKey: form.apiKey,
    model: form.model,
    models: form.models || [],
    concurrency: form.concurrency || 2,
    lastTestAt: '',
    lastTestOk: null
  };
  const ok = M.saveSettings(M.get());
  // 保存失败时回滚内存中的 ai，模拟主脚本“不留脏状态”的行为。
  if (!ok) M.get().ai = previousAi;
  return ok;
}

// ===== 场景 1：首次配置 → 保存 → 重新加载（等价于关弹窗/刷新）=====
{
  const M = build();
  const toasts = [];
  M.setToast((m, t) => toasts.push([t, m]));

  check('初始未配置', M.get().ai.model, '');
  const ok = simulateDialogSave(M, {
    baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-abc123456', model: 'Qwen/Qwen2.5-7B-Instruct'
  });
  check('首次保存成功', ok, true);

  // 重新加载（新模块实例，读同一个 localStorage）—— 模拟刷新页面
  const M2 = build();
  check('重开后 Base URL 仍在', M2.get().ai.baseUrl, 'https://api.siliconflow.cn/v1');
  check('重开后 API Key 仍在', M2.get().ai.apiKey, 'sk-abc123456');
  check('重开后模型仍在', M2.get().ai.model, 'Qwen/Qwen2.5-7B-Instruct');
  check('重开后判定为已配置', !!(M2.get().ai.baseUrl && M2.get().ai.apiKey && M2.get().ai.model), true);
}

// ===== 场景 2：多次保存不互相覆盖（改模型后再重开）=====
{
  const M = build();
  simulateDialogSave(M, { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-first', model: 'deepseek-chat' });
  const M2 = build();
  const ok2 = simulateDialogSave(M2, { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-first', model: 'deepseek-reasoner' });
  check('二次保存成功', ok2, true);
  const M3 = build();
  check('二次保存后模型已更新', M3.get().ai.model, 'deepseek-reasoner');
  check('二次保存后 Key 未丢', M3.get().ai.apiKey, 'sk-first');
  check('Base URL 未丢', M3.get().ai.baseUrl, 'https://api.deepseek.com/v1');
}

// ===== 场景 3：保存失败时不写入脏状态 =====
{
  // 换成极小配额
  const map2 = new Map();
  let used2 = 0;
  const savedStorage = global.localStorage;
  global.localStorage = {
    getItem: k => (map2.has(k) ? map2.get(k) : null),
    setItem(k, v) {
      const old = map2.has(k) ? size(map2.get(k)) : 0;
      const next = used2 - old + size(v);
      if (next > 60) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      if (map2.has(k)) map2.delete(k);
      map2.set(k, String(v));
      used2 = next;
    },
    removeItem(k) { if (map2.has(k)) { used2 -= size(map2.get(k)); map2.delete(k); } }
  };
  const M = build();
  const toasts = [];
  M.setToast((m, t) => toasts.push([t, m]));
  const before = JSON.stringify(M.get().ai);
  const ok = simulateDialogSave(M, { baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm' });
  check('配额不足：保存返回 false', ok, false);
  check('配额不足：弹出错误提示', toasts.some(t => t[0] === 'err'), true);
  global.localStorage = savedStorage;
}

// ===== 场景 4：models 列表持久化 =====
{
  const M = build();
  simulateDialogSave(M, {
    baseUrl: 'https://api.openai.com', apiKey: 'sk-x', model: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-mini']
  });
  const M2 = build();
  check('模型列表持久化', M2.get().ai.models, ['gpt-4o', 'gpt-4o-mini', 'o1-mini']);
}

// ===== 场景 5：并发数持久化与夹紧 =====
{
  const M = build();
  simulateDialogSave(M, { baseUrl: 'https://a.com', apiKey: 'k', model: 'm', concurrency: 4 });
  const M2 = build();
  check('并发数持久化', M2.get().ai.concurrency, 4);

  const M3 = build();
  simulateDialogSave(M3, { baseUrl: 'https://a.com', apiKey: 'k', model: 'm', concurrency: 99 });
  const M4 = build();
  check('超限并发被夹到 6', M4.get().ai.concurrency, 6);
}

const f = path.join(__dirname, '.build-ai-ui.js');
try { fs.unlinkSync(f); } catch (e) {}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
