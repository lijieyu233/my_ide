const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const Text = require('../text-format');
const Lines = require('../renderer/text-lines');
const State = require('@codemirror/state');
const Commands = require('@codemirror/commands');
const CM = { State, Commands };
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok ' + name); }
// 构造独立已知字节而非用被测encodeText造“正确答案”。
function fixture(content, encoding, bom) {
  let bytes = encoding === 'gbk' ? iconv.encode(content, 'gbk') : Buffer.from(content, encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf16be') bytes.swap16();
  return bom ? Buffer.concat([Buffer.from(encoding === 'utf8' ? [239,187,191] : encoding === 'utf16le' ? [255,254] : [254,255]), bytes]) : bytes;
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-text-format-test-'));
try {
  for (const encoding of ['utf8', 'utf16le', 'utf16be', 'gbk']) {
    for (const bom of encoding === 'gbk' ? [false] : [false, true]) {
      for (const content of ['中文 ABC\r\n', 'ABC\n中文\n', 'A\r\nB\nC\rD', '', '纯中文']) {
        test(`${encoding}/${bom ? 'BOM' : '无BOM'}/${JSON.stringify(content)}逐字节往返`, () => {
          const bytes = fixture(content, encoding, bom), file = path.join(temp, 'fixture.bin');
          fs.writeFileSync(file, bytes);
          // 无BOM空UTF-16/全中文本来无法可靠推测，显式指定才有此能力。
          const read = Text.decodeText(fs.readFileSync(file), !bom && encoding.startsWith('utf16') ? encoding : undefined);
          assert.equal(read.content, content); assert.equal(read.encoding, encoding === 'gbk' && !/[^\x00-\x7f]/.test(content) ? 'utf8' : encoding);
          assert.equal(read.textFormat.bom, bom);
          assert.deepEqual(Text.encodeText(read.content, read.textFormat), bytes);
        });
      }
    }
  }
  test('无BOM UTF-16两种字节序启发式明确标记', () => {
    for (const encoding of ['utf16le','utf16be']) {
      const r = Text.decodeText(fixture('中文 ABC\r\n', encoding, false));
      assert.equal(r.encoding, encoding); assert.equal(r.textFormat.detection, 'heuristic'); assert(!r.textFormat.bom);
    }
  });
  test('GBK兜底标推测并有无损字节标记', () => {
    const r = Text.decodeText(iconv.encode('中文 ABC', 'gbk'));
    assert.equal(r.textFormat.detection, 'fallback'); assert(r.textFormat.canonical);
  });
  test('真实GBK非规范欧元双字节拒绝写成不同字节',()=>{
    const bytes=Buffer.from([0xa2,0xe3]),r=Text.decodeText(bytes,'gbk');
    assert.equal(r.content,'€');assert.equal(r.textFormat.canonical,false);
    assert.throws(()=>Text.encodeText(r.content,r.textFormat),{code:'ENCODING_LOSS'});
    assert.deepEqual(bytes,Buffer.from([0xa2,0xe3]));
  });
  test('GBK emoji和非等价字形拒绝，ASCII问号正常', () => {
    assert.throws(() => Text.encodeText('中文 😀', { encoding:'gbk' }), { code:'ENCODING_LOSS' });
    assert.throws(() => Text.encodeText('中文 — 〜', { encoding:'gbk' }), { code:'ENCODING_LOSS' });
    assert.deepEqual(Text.encodeText('?', { encoding:'gbk' }), Buffer.from('?'));
    assert.throws(() => Text.encodeText('正文', { encoding:'gbk', canonical:false }), { code:'ENCODING_LOSS' });
  });
  test('UTF-8显式转换emoji可重读且BOM选择独立', () => {
    for (const bom of [false,true]) {
      const bytes = Text.encodeText('中文 😀', { encoding:'utf8', bom });
      assert.equal(Text.decodeText(bytes).content, '中文 😀'); assert.equal(Text.decodeText(bytes).textFormat.bom,bom);
    }
  });
  test('正文U+FEFF不被额外吞掉', () => {
    for (const encoding of ['utf8','utf16le','utf16be']) {
      const bytes = fixture('\ufeff正文',encoding,true);
      const r=Text.decodeText(bytes); assert.equal(r.content,'\ufeff正文'); assert.deepEqual(Text.encodeText(r.content,r.textFormat),bytes);
    }
  });
  test('未知编码、GBK BOM、孤立代理项与奇数UTF-16稳定拒绝', () => {
    assert.throws(()=>Text.encodeText('A',{encoding:'shift-jis'}),{code:'UNSUPPORTED_ENCODING'});
    assert.throws(()=>Text.decodeText(Buffer.from('A'),'shift-jis'),{code:'UNSUPPORTED_ENCODING'});
    assert.throws(()=>Text.encodeText('A',{encoding:'gbk',bom:true}),{code:'INVALID_FORMAT'});
    for(const encoding of ['utf8','utf16le','utf16be','gbk']) assert.throws(()=>Text.encodeText('\ud800',{encoding}),{code:'ENCODING_LOSS'});
    assert.throws(()=>Text.decodeText(Buffer.from([255,254,65])),{code:'INVALID_ENCODING'});
    assert.throws(()=>Text.decodeText(Buffer.from([255,254,0,216])),{code:'INVALID_ENCODING'});
    assert.throws(()=>Text.decodeText(Buffer.from([239,187,191,255])),{code:'INVALID_ENCODING'});
    assert.throws(()=>Text.decodeText(Buffer.from([129]),'gbk'),{code:'INVALID_ENCODING'});
  });
  test('换行元数据区分CRLF/LF/CR/混合/空', () => {
    assert.deepEqual(['a\r\nb','a\nb','a\rb','a\r\nb\nc','a'].map(Text.eolOf),['CRLF','LF','CR','MIXED',null]);
  });
  test('二进制不会自动作为GBK文本', () => assert(Text.decodeText(Buffer.from([1,0,2,0])).binary));
  const raw = 'A\r\nB\nC\rD\r\n';
  const create = () => State.EditorState.create({doc:raw,extensions:[...Lines.extension(CM,raw),Commands.history()]});
  test('真实CM6字符交易保持所有未触及换行', () => {
    let s=create(); s=s.update({changes:[{from:0,to:1,insert:'新A'},{from:4,to:5,insert:'新C'}]}).state;
    assert.equal(Lines.raw(s),'新A\r\nB\n新C\rD\r\n');
  });
  test('真实CM6插入行采用原主换行，删除保留后继换行', () => {
    let s=create(); s=s.update({changes:{from:2,to:4,insert:'X\nY\n'}}).state;
    assert.equal(Lines.raw(s),'A\r\nX\r\nY\r\nC\rD\r\n');
  });
  test('真实CM6 undo/redo及分组回滚保持混合行尾', () => {
    let state=create(); const target={get state(){return state},dispatch(tr){state=tr.state;}};
    state=state.update({changes:{from:0,to:4,insert:'新\n'},annotations:State.Transaction.userEvent.of('input')}).state;
    const edited=Lines.raw(state);
    assert(Commands.undo(target)); assert.equal(Lines.raw(state),raw);
    assert(Commands.redo(target)); assert.equal(Lines.raw(state),edited);
    state=state.update({changes:{from:0,to:0,insert:'一'},annotations:State.Transaction.userEvent.of('input.type')}).state;
    state=state.update({changes:{from:1,to:1,insert:'二'},annotations:State.Transaction.userEvent.of('input.type')}).state;
    assert(Commands.undo(target)); assert.equal(Lines.raw(state),edited);
  });
  test('同正文仅行尾reset是可撤销的格式交易', () => {
    let state=create();const target={get state(){return state},dispatch(tr){state=tr.state;}};
    state=state.update({changes:{from:0,to:state.doc.length,insert:'A\nB\nC\nD\n'},effects:Lines.reset('A\nB\nC\nD\n')}).state;
    assert(Commands.undo(target));assert.equal(Lines.raw(state),raw);
  });
  test('textarea字符替换和局部增删行保留外部行尾', () => {
    assert.equal(Lines.reconcile(raw,'AA\nB\nC\nD\n'),'AA\r\nB\nC\rD\r\n');
    assert.equal(Lines.reconcile(raw,'A\nB\nD\n'),'A\r\nB\nD\r\n');
    assert.equal(Lines.reconcile(raw,'A\nB\nC\n新增\nD\n'),'A\r\nB\nC\r新增\r\nD\r\n');
  });
  console.log(`结果: ${passed} 通过, 0 失败`);
} catch(e){console.error(e);process.exitCode=1;}
finally {
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-text-format-test-'))throw Error('Unsafe cleanup');
  fs.rmSync(temp,{recursive:true,force:true});
}
