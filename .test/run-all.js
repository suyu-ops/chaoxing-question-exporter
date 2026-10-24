// 一键运行全部回归测试。运行：node .test/run-all.js
const { spawnSync } = require('child_process');
const path = require('path');

const tests = ['parse.test.js', 'docx.test.js', 'ai.test.js', 'dialog.test.js', 'editor-ai.test.js', 'editor-flow.test.js', 'bank-normalize.test.js', 'settings.test.js', 'ai-persist.test.js', 'export.test.js', 'export-flow.test.js', 'feedback-bugs.test.js', 'checkbox.test.js', 'pacing.test.js', 'declaration-order.test.js', 'smoke.test.js', 'type-infer.test.js', 'batch-progress.test.js'];
let failed = 0;

for (const file of tests) {
  console.log(`\n===== ${file} =====`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(failed ? `\n${failed} 个测试文件失败` : '\n全部测试文件通过');
process.exit(failed ? 1 : 0);
