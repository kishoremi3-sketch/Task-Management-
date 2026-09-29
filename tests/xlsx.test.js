import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { buildXlsx, columnName, sheetNames, crc32 } from '../js/xlsx.js';

// Reads a stored (uncompressed) zip into { name: text }.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0, 'stored');
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    assert.equal(crc, zlibCrc32(data), `crc for ${name}`);
    files[name] = new TextDecoder().decode(data);
    at += 30 + nameLen + size;
  }
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'end of central directory');
  return files;
}

test('column names follow A..Z, AA..ZZ, AAA', () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
});

test('sheet names are cleaned, shortened and unique', () => {
  assert.deepEqual(sheetNames(['By person', 'By person', 'a/b:c?', 'x'.repeat(40), '']),
    ['By person', 'By person (2)', 'a b c', 'x'.repeat(31), 'Sheet']);
});

test('crc32 matches zlib', () => {
  const data = new TextEncoder().encode('TaskFlow ✓');
  assert.equal(crc32(data), zlibCrc32(data));
});

test('buildXlsx writes a valid package with typed cells', () => {
  const bytes = buildXlsx([
    { name: 'Summary', title: 'Report: Design', columns: ['Item', 'Value'], rows: [['Tasks', 3], ['Goal', 'Ship <fast> & "well"']] },
    { name: 'Task list', columns: ['Task', 'Points'], rows: [['Café menu', 5], ['No estimate', '']] },
  ]);
  const files = readZip(bytes);
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]);
  assert.match(files['xl/workbook.xml'], /<sheet name="Summary" sheetId="1" r:id="rId1"\/><sheet name="Task list"/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<c r="A1" s="2" t="inlineStr"><is><t xml:space="preserve">Report: Design<\/t>/, 'title row');
  assert.match(s1, /<c r="A3" s="1" t="inlineStr">/, 'header on row 3 after the title');
  assert.match(s1, /<c r="B4"><v>3<\/v><\/c>/, 'numbers stay numbers');
  assert.match(s1, /Ship &lt;fast&gt; &amp; &quot;well&quot;/, 'text is escaped');
  assert.match(s1, /<pane ySplit="3" topLeftCell="A4"/, 'header row is frozen');
  const s2 = files['xl/worksheets/sheet2.xml'];
  assert.match(s2, /Café menu/);
  assert.doesNotMatch(s2, /<c r="B3"/, 'empty values are left out');
  assert.match(s2, /<autoFilter ref="A1:B3"\/>/);
});
