// 静态时序检查：防止「let/const 定义在使用点之后」导致的 TDZ 崩溃。
//
// 背景：v1.9.0 出现过两次同类事故——
//   1. BATCH_PACING_PROFILES 定义在 createPanel 之后，但设置弹窗要用它
//   2. observer 定义在文件末尾，但 createPanel 第一行就访问它
// 两者都会让 createPanel() 抛
//   ReferenceError: Cannot access 'xxx' before initialization
// 面板照常渲染出来，但事件绑定在异常处中断 → 所有按钮点不动。
// 语法检查发现不了这类问题，本文件专门扫描。
const fs = require('fs');
const path = require('path');
const { SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 收集顶层声明（2 空格缩进）----
const topDecls = new Map();
lines.forEach((line, index) => {
  const fn = line.match(/^ {2}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/);
  if (fn) { topDecls.set(fn[1], { line: index + 1, kind: 'function' }); return; }
  const v = line.match(/^ {2}(?:const|let|var) ([A-Za-z_$][\w$]*)\s*=/);
  if (v) topDecls.set(v[1], { line: index + 1, kind: 'variable' });
});

const createPanelLine = topDecls.has('createPanel') ? topDecls.get('createPanel').line : -1;
check('能定位 createPanel', createPanelLine > 0, true);

// ---- createPanel 的近似结束行 ----
const sortedDecls = [...topDecls.entries()].sort((a, b) => a[1].line - b[1].line);
const cpIdx = sortedDecls.findIndex(([name]) => name === 'createPanel');
const nextAfterCp = sortedDecls[cpIdx + 1];
const createPanelEnd = nextAfterCp ? nextAfterCp[1].line : lines.length;

// ==================== 1. createPanel 内的 TDZ ====================
{
  const usedInPanel = new Map();
  for (let i = createPanelLine - 1; i < createPanelEnd - 1; i++) {
    const code = lines[i].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    for (const name of topDecls.keys()) {
      if (usedInPanel.has(name)) continue;
      const re = new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '([^\\w$]|$)');
      if (re.test(code)) usedInPanel.set(name, i + 1);
    }
  }

  const violations = [];
  for (const [name, usedLine] of usedInPanel) {
    const decl = topDecls.get(name);
    if (!decl || decl.kind !== 'variable') continue;   // 函数声明会提升，安全
    if (decl.line > createPanelLine && usedLine < decl.line) {
      violations.push({ name, usedLine, declLine: decl.line });
    }
  }
  check('createPanel 内无 TDZ 风险变量', violations, []);
}

// ==================== 2. 初始化期调用的函数 TDZ 扫描 ====================
// 精确规则：普通函数体里的 let/const 引用在「调用时」才求值，几乎总在
// 模块加载完成后，所以不算风险。真正会炸的是**初始化期就会被执行**的
// 函数——它们可能在某个 let/const 执行到之前被调用。
//
// 这类函数包括：
//   - createPanel（DOMContentLoaded / MutationObserver 触发）
//   - 所有在顶层同步代码里被直接调用/立即执行的函数
{
  // 找出顶层同步代码中「立即调用」的函数名：形如 `foo(...)` 出现在
  // 顶层（2 空格缩进）且不是函数声明本身。
  const calledAtLoad = new Set();
  lines.forEach(line => {
    if (!/^ {2}\S/.test(line)) return;
    if (/^ {2}(?:async )?function /.test(line)) return;
    if (/^ {2}(?:const|let|var) /.test(line)) {
      // const x = foo(...) 里的 foo 会在加载期被调用
      const rhs = line.replace(/^ {2}(?:const|let|var) [A-Za-z_$][\w$]*\s*=/, '');
      for (const m of rhs.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (topDecls.get(m[1]) && topDecls.get(m[1]).kind === 'function') calledAtLoad.add(m[1]);
      }
      return;
    }
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (topDecls.get(m[1]) && topDecls.get(m[1]).kind === 'function') calledAtLoad.add(m[1]);
    }
  });

  // createPanel 一定在初始化期执行
  calledAtLoad.add('createPanel');
  calledAtLoad.add('loadSettings');

  const declList = sortedDecls;
  const violations = [];

  // 白名单：这些函数虽然出现在顶层，但真正执行在 let/const 初始化之后
  // （例如 appendUserscriptStyle 是「声明在 style 之前、调用在 style 之后」）。
  const SKIP = new Set(['appendUserscriptStyle']);

  declList.forEach(([fnName, fnInfo], idx) => {
    if (fnInfo.kind !== 'function') return;
    if (SKIP.has(fnName)) return;
    if (!calledAtLoad.has(fnName)) return;      // 只在运行期被调用，不检查
    const fnStart = fnInfo.line;
    const fnEnd = idx + 1 < declList.length ? declList[idx + 1][1].line : lines.length;
    const body = lines.slice(fnStart - 1, fnEnd - 1);

    // 收集本函数的形参名与内部局部声明名，避免把参数/局部变量误判为顶层变量。
    const shadowed = new Set();
    const headerLines = body.slice(0, 6).join(' ');
    const paramMatch = headerLines.match(/\(([^)]*)\)/);
    if (paramMatch) {
      paramMatch[1].split(',').forEach(part => {
        const name = part.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) shadowed.add(name);
      });
    }
    for (const line of body) {
      for (const m of line.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) shadowed.add(m[1]);
      for (const m of line.matchAll(/(?:const|let|var)\s+\{([^}]*)\}/g)) {
        m[1].split(',').forEach(part => {
          const name = part.split(':').pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) shadowed.add(name);
        });
      }
      for (const m of line.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) shadowed.add(m[1]);
    }

    for (let offset = 0; offset < body.length; offset++) {
      const code = body[offset].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      for (const [name, decl] of declList) {
        if (name === fnName) continue;
        if (decl.kind !== 'variable') continue;
        if (decl.line <= fnStart) continue;
        if (shadowed.has(name)) continue;      // 被形参/局部变量遮蔽，安全
        // 用  保证整词匹配，避免 `style` 命中 `styleElement` 这类前缀。
        const re = new RegExp('(^|[^\w$])' + name.replace(/\$/g, '\$') + '($|[^\w$])');
        if (re.test(code)) {
          violations.push({ fn: fnName, name, usedAt: fnStart + offset, declAt: decl.line });
        }
      }
    }
  });

  check('初始化期函数无 TDZ 风险', violations.slice(0, 6), []);
}

// ==================== 3. 关键常量/变量位置 ====================
{
  check('BATCH_PACING_PROFILES 在 createPanel 之前定义',
    topDecls.get('BATCH_PACING_PROFILES').line < createPanelLine, true);
  check('BATCH_RISK_PATTERN 在 createPanel 之前定义',
    topDecls.get('BATCH_RISK_PATTERN').line < createPanelLine, true);
  check('observer 在 createPanel 之前声明',
    topDecls.get('observer').line < createPanelLine, true);
  check('initTimer 在 createPanel 之前声明',
    topDecls.get('initTimer').line < createPanelLine, true);
}

// ==================== 4. 关键依赖必须存在且可提升 ====================
{
  const required = [
    'xxtChooseExportOptions', 'xxtChooseExportFormat', 'openAiSettings',
    'xxtAiConfigReady', 'xxtAiConfigHint', 'xxtAiListModels', 'xxtAiChat',
    'saveSettings', 'loadSettings', 'describeSettingsStorage',
    'xxtParseBankFile', 'xxtChooseExportOptions', 'showGlobalToast'
  ];
  const missing = [...new Set(required)].filter(name => !topDecls.has(name));
  check('关键依赖全部有顶层定义', missing, []);

  const notHoisted = [...new Set(required)].filter(name => {
    const decl = topDecls.get(name);
    const line = lines[decl.line - 1] || '';
    return !/^\s{2}(?:async )?function /.test(line);
  });
  check('关键依赖用 function 声明（可提升）', notHoisted, []);
}

// ==================== 5. 面板按钮都有绑定 ====================
{
  const mustBind = [
    'xxt-btnExtract', 'xxt-bankBtn', 'xxt-btnDownload', 'xxt-btnPreview',
    'xxt-btnCopy', 'xxt-btnEdit', 'xxt-btnSaveToBank', 'xxt-btnBatchExtract'
  ];
  const panelSrc = lines.slice(createPanelLine - 1, createPanelEnd - 1).join('\n');
  const unbound = mustBind.filter(name => !panelSrc.includes(name));
  check('主面板关键按钮都出现在绑定代码中', unbound, []);

  const bindCount = (panelSrc.match(/els\.\w+\.addEventListener/g) || []).length;
  check('面板内事件绑定数量合理（>5）', bindCount > 5, true);
}

// ==================== 6. createPanel 顶部不能有裸的未定义访问 ====================
{
  // 取出 createPanel 前 20 行，检查其中引用的标识符都有来源
  const head = lines.slice(createPanelLine - 1, createPanelLine + 20).join('\n');
  check('createPanel 开头不再直接依赖后置变量', /if \(observer\)/.test(head), true);
  check('observer 已在 createPanel 之前初始化（赋 null）',
    /let observer = null;/.test(src) && topDecls.get('observer').line < createPanelLine, true);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
