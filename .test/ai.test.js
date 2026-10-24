// AI 应答归一化 + JSON 题库往返回归测试。
const fs = require('fs');
const path = require('path');
const { buildModule, SRC } = require('./extract');

const code = buildModule({
  xxtNormalizeAiAnswer: 'xxtNormalizeAiAnswer',
  xxtExtractJson: 'xxtExtractJson',
  xxtAiShortError: 'xxtAiShortError',
  xxtNormalizeAiBaseUrl: 'xxtNormalizeAiBaseUrl',
  xxtNormalizeType: 'xxtNormalizeType',
  xxtJudgeAnswerFromLetter: 'xxtJudgeAnswerFromLetter',
  xxtLooksLikeJudgeAnswer: 'xxtLooksLikeJudgeAnswer'
});
const modulePath = path.join(__dirname, '.build-ai.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- Base URL 归一化 ----
check('补 /v1', M.xxtNormalizeAiBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1');
check('保留 /v1', M.xxtNormalizeAiBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
check('去掉尾部斜杠', M.xxtNormalizeAiBaseUrl('https://x.com/v1/'), 'https://x.com/v1');
check('去掉 chat/completions', M.xxtNormalizeAiBaseUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1');
check('保留 /v1beta', M.xxtNormalizeAiBaseUrl('https://x.com/v1beta'), 'https://x.com/v1beta');
check('空值', M.xxtNormalizeAiBaseUrl(''), '');

// ---- JSON 抽取 ----
check('裸 JSON', M.xxtExtractJson('{"answer":"A"}'), { answer: 'A' });
check('代码块包裹', M.xxtExtractJson('```json\n{"answer":"B","confidence":0.9}\n```'), { answer: 'B', confidence: 0.9 });
check('前后有解释文字', M.xxtExtractJson('好的，结果是：{"answer":"C"} 希望有帮助'), { answer: 'C' });
check('无 JSON 返回 null', M.xxtExtractJson('无法确定'), null);

// ---- 答案归一化 ----
check('单选取首字母', M.xxtNormalizeAiAnswer('选项 A 正确', '单选'), 'A');
check('单选小写转大写', M.xxtNormalizeAiAnswer('b', '单选'), 'B');
check('多选排序去重', M.xxtNormalizeAiAnswer('DBAAB', '多选'), 'ABD');
check('多选带分隔符', M.xxtNormalizeAiAnswer('A、C、B', '多选'), 'ABC');
check('判断题 正确→对', M.xxtNormalizeAiAnswer('正确', '判断'), '对');
check('判断题 TRUE→对', M.xxtNormalizeAiAnswer('TRUE', '判断'), '对');
check('判断题 错误→错', M.xxtNormalizeAiAnswer('不正确', '判断'), '错');
check('去掉答案前缀', M.xxtNormalizeAiAnswer('答案：C', '单选'), 'C');
check('去掉引号', M.xxtNormalizeAiAnswer('"北京"', '填空'), '北京');
check('填空保留原文', M.xxtNormalizeAiAnswer('细胞膜；线粒体', '填空'), '细胞膜；线粒体');
check('空答案', M.xxtNormalizeAiAnswer('', '单选'), '');

// ---- 错误信息精简 ----
check(
  'OpenAI 错误体',
  M.xxtAiShortError('{"error":{"message":"Invalid API key","type":"auth"}}'),
  'Invalid API key'
);
check('HTML 错误页', M.xxtAiShortError('<html><body>502 Bad Gateway</body></html>'), '502 Bad Gateway');
check('空错误', M.xxtAiShortError(''), '无返回内容');

// ---- 功能接线检查（防止改错文件/删错按钮）----
const roundtripSrc = fs.readFileSync(SRC, 'utf8');
check('题库区提供统一导出按钮', roundtripSrc.includes('id="xxt-bank-export"'), true);
check('已移除分散的导出按钮', roundtripSrc.includes('xxt-bank-export-word'), false);
check('导入入口文案为“导入题库”', roundtripSrc.includes('>导入题库<'), true);
check('JSON 备份带 schemaVersion', roundtripSrc.includes('schemaVersion: 1') && roundtripSrc.includes('exportedAt'), true);
check('AI 面板存在', roundtripSrc.includes('xxt-bank-ai-actions'), true);
check('一键获取模型存在', roundtripSrc.includes('data-ai-fetch-models'), true);
check('未完成任务点弹层处理已接入', roundtripSrc.includes('clickBatchBlockingDialogNext'), true);
check('批量导航调用弹层清理', roundtripSrc.includes('drainBatchBlockingDialogs'), true);
check('导出格式弹窗包含 JSON', roundtripSrc.includes("value: 'json'"), true);

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
