// DOCX 解析回归：构造一个最小 DOCX（用脚本内置的 ZIP 写入思路不可行，
// 这里用 Node 的 zlib 手工拼一个 deflate 压缩的 docx），验证解析结果。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildModule } = require('./extract');

const code = buildModule({
  xxtParseQuestionsFromText: 'xxtParseQuestionsFromText',
  xxtNormalizeType: 'xxtNormalizeType',
  xxtUnzip: 'xxtUnzip',
  xxtReadZipEntry: 'xxtReadZipEntry',
  xxtDecodeXmlEntities: 'xxtDecodeXmlEntities',
  xxtDocxXmlToText: 'xxtDocxXmlToText',
  xxtDetectBankFileKind: 'xxtDetectBankFileKind',
  xxtJudgeAnswerFromLetter: 'xxtJudgeAnswerFromLetter',
  xxtLooksLikeJudgeAnswer: 'xxtLooksLikeJudgeAnswer'
});
const modulePath = path.join(__dirname, '.build-docx.js');
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

// ---- 最小 ZIP 写入器（store + deflate） ----
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      for (let b = 0; b < 8; b++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      t[i] = v >>> 0;
    }
    return t;
  })();
  const crc32 = bytes => {
    let v = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) v = crcTable[(v ^ bytes[i]) & 0xFF] ^ (v >>> 8);
    return (v ^ 0xFFFFFFFF) >>> 0;
  };
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

function paragraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  [
    '一、单项选择题',
    '1.【单选题】下列哪个是质数？',
    'A. 4',
    'B. 6',
    'C. 7',
    'D. 9',
    '答案：C',
    '解析：7 只能被 1 和自身整除。',
    '2. 2+2=?',
    'A. 3',
    'B. 4',
    '答案：B'
  ].map(t => paragraph(t.replace(/&/g, '&amp;').replace(/</g, '&lt;'))).join('') +
  '</w:body></w:document>';

const zipBuffer = makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: docXml }
]);

// Node 的 Blob 提供 arrayBuffer/text
const file = new Blob([zipBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
Object.defineProperty(file, 'name', { value: '题库.docx' });

(async () => {
  check('文件类型识别 docx', M.xxtDetectBankFileKind(file), 'docx');

  const zip = await M.xxtUnzip(await file.arrayBuffer());
  const xml = await M.xxtReadZipEntry(zip, 'word/document.xml');
  check('能读到 document.xml', typeof xml === 'string' && xml.includes('质数'), true);

  const text = M.xxtDocxXmlToText(xml);
  const lines = text.split('\n');
  check('段落数为 12', lines.length, 12);
  check('第一段', lines[0], '一、单项选择题');
  check('第6段（答案）', lines[6], '答案：C');

  const grouped = M.xxtParseQuestionsFromText(text);
  check('DOCX → 单选数量', grouped['单选'].length, 2);
  check('DOCX 第1题答案', grouped['单选'][0] && grouped['单选'][0].correctAnswer, 'C');
  check('DOCX 第1题解析', grouped['单选'][0] && grouped['单选'][0].explanation, '7 只能被 1 和自身整除。');
  check('DOCX 第2题选项', grouped['单选'][1] && grouped['单选'][1].options, ['3', '4']);

  fs.unlinkSync(modulePath);
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
