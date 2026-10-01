/**
 * Pasted images: type sniffing, file names, picking ids, the sweep, and the prompt blocks and their caps.
 * Run: npm run test:attachments. Works in a throwaway folder under the OS temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, State } from '../shared/types';

// The store reads data/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-attach-'));
process.chdir(root);
const att = await import('./attachments');
const content = await import('./runner/content');
const PID = 'demo';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

let passed = 0;
const cases: [string, () => void][] = [];
const test = (name: string, fn: () => void) => cases.push([name, fn]);

test('sniff: real images pass, everything else fails', () => {
  assert.equal(att.sniffImage(PNG), 'image/png');
  assert.equal(att.sniffImage(JPEG), 'image/jpeg');
  assert.equal(att.sniffImage(WEBP), 'image/webp');
  assert.equal(att.sniffImage(GIF), 'image/gif');
  for (const bad of [SVG, HTML, ZIP, Buffer.alloc(0), Buffer.from('RIFF....WAVE')]) assert.equal(att.sniffImage(bad), null);
});

test('upload: saves under a server-made name, type from the bytes', () => {
  const a = att.saveUpload(PID, JPEG, 'you');
  assert.match(a.file, /^att_[a-f0-9]{12}\.jpg$/);
  assert.equal(a.type, 'image/jpeg');
  assert.equal(a.size, JPEG.length);
  assert.ok(fs.existsSync(path.join(att.attachmentsDir(PID), a.file)));
});

test('upload: refuses SVG, HTML, empty and too big', () => {
  assert.throws(() => att.saveUpload(PID, SVG, 'you'), /Only PNG, JPEG, WebP and GIF/);
  assert.throws(() => att.saveUpload(PID, HTML, 'you'), /Only PNG/);
  assert.throws(() => att.saveUpload(PID, Buffer.alloc(0), 'you'), /empty/);
  assert.throws(() => att.saveUpload(PID, Buffer.concat([PNG, Buffer.alloc(3_800_000)]), 'you'), /3.75 MB/);
});

test('serve: only our own file names resolve', () => {
  assert.ok(att.resolveAttachment(PID, 'att_0123456789ab.png')?.endsWith(path.join('attachments', 'att_0123456789ab.png')));
  for (const bad of ['../db.json', 'att_0123456789ab.png/../../db.json', '..%2Fdb.json', 'att_zz.png', 'att_0123456789ab.svg', 'att_0123456789ab.html', 'ATT_0123456789AB.PNG', '']) {
    assert.equal(att.resolveAttachment(PID, bad), null, bad);
  }
});

test('pick: real ids come back with type and size from the file', () => {
  const a = att.saveUpload(PID, PNG, 'you');
  const [picked] = att.pickAttachments(PID, [a.id, a.id], 'you');
  assert.equal(picked.file, a.file);
  assert.equal(picked.type, 'image/png');
  assert.equal(att.pickAttachments(PID, undefined, 'you').length, 0);
});

test('pick: unknown ids, bad shapes, too many, and disguised files are refused', () => {
  assert.throws(() => att.pickAttachments(PID, ['att_ffffffffffff'], 'you'), /not found/);
  assert.throws(() => att.pickAttachments(PID, 'att_x', 'you'), /list/);
  assert.throws(() => att.pickAttachments(PID, [1, 2], 'you'), /list/);
  const many = Array.from({ length: 7 }, () => att.saveUpload(PID, PNG, 'you').id);
  assert.throws(() => att.pickAttachments(PID, many, 'you'), /At most 6/);
  // Someone swaps a saved image's bytes for HTML: it no longer counts as an image.
  const a = att.saveUpload(PID, PNG, 'you');
  fs.writeFileSync(path.join(att.attachmentsDir(PID), a.file), HTML);
  assert.throws(() => att.pickAttachments(PID, [a.id], 'you'), /not an image/);
});

test('sweep: old unused images go, used and recent ones stay', () => {
  const dir = att.attachmentsDir(PID);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  const used = att.saveUpload(PID, PNG, 'you');
  const orphanOld = att.saveUpload(PID, PNG, 'you');
  const orphanNew = att.saveUpload(PID, PNG, 'you');
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  fs.utimesSync(path.join(dir, used.file), old, old);
  fs.utimesSync(path.join(dir, orphanOld.file), old, old);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  const state = { messages: [], instructions: [], items: [{ comments: [{ attachments: [used] }] }] } as unknown as State;
  assert.equal(att.sweepAttachments(PID, state), 1);
  assert.ok(fs.existsSync(path.join(dir, used.file)), 'referenced image kept');
  assert.ok(!fs.existsSync(path.join(dir, orphanOld.file)), 'old orphan removed');
  assert.ok(fs.existsSync(path.join(dir, orphanNew.file)), 'recent orphan kept');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'files that are not ours are never touched');
});

test('prompt: no images keeps the plain string', () => {
  assert.equal(content.userContent('hello', PID, []), 'hello');
});

test('prompt: text first, then base64 image blocks, newest 6 inline, the rest by path', () => {
  const list: Attachment[] = Array.from({ length: 8 }, () => att.saveUpload(PID, PNG, 'you'));
  const out = content.userContent('Look at these', PID, list);
  assert.ok(Array.isArray(out));
  const blocks = out as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text!, /^Look at these/);
  assert.match(blocks[0].text!, /attached 6 images/);
  const images = blocks.slice(1);
  assert.equal(images.length, 6);
  assert.ok(images.every((b) => b.type === 'image' && b.source?.type === 'base64' && b.source.media_type === 'image/png'));
  assert.equal(Buffer.from(images[0].source!.data, 'base64').subarray(0, 8).toString('hex'), PNG.subarray(0, 8).toString('hex'));
  // The two oldest are listed by path instead.
  assert.ok(blocks[0].text!.includes(list[0].file) && blocks[0].text!.includes(list[1].file));
  assert.ok(!blocks[0].text!.includes(list[7].file));
});

const fake = (n: number, size: number): Attachment => ({ id: `att_${String(n).padStart(12, '0')}`, file: `att_${String(n).padStart(12, '0')}.png`, type: 'image/png', size, by: 'you', ts: '' });

test('split: the byte cap stops inline at the newest that fit, exactly at the limit too', () => {
  const third = content.PROMPT_IMAGE_BYTES / 3;
  const list = Array.from({ length: 5 }, (_, i) => fake(i, third));
  const { inline, rest } = content.splitImages(list);
  assert.deepEqual(inline.map((a) => a.id), [list[2].id, list[3].id, list[4].id], 'three thirds add up to the cap and still fit, in their original order');
  assert.deepEqual(rest.map((a) => a.id), [list[0].id, list[1].id]);
});

test('split: a big newest image does not let an older small one jump ahead', () => {
  const list = [fake(1, 1_000), fake(2, 2_000_000), fake(3, content.PROMPT_IMAGE_BYTES - 1_000_000)];
  const { inline, rest } = content.splitImages(list);
  assert.deepEqual(inline.map((a) => a.id), [list[2].id], 'inline is always the newest run of images');
  assert.deepEqual(rest.map((a) => a.id), [list[0].id, list[1].id]);
  assert.equal(content.splitImages(list, 6, Infinity).inline.length, 3, 'without the byte cap, the count cap alone applies');
});

test('prompt: images past the byte cap are listed by path, not sent inline', () => {
  // Real small files on disk, but metadata that says 4 MB each: only the two newest fit under 9 MB.
  const list: Attachment[] = Array.from({ length: 4 }, () => ({ ...att.saveUpload(PID, PNG, 'you'), size: 4_000_000 }));
  const out = content.userContent('Big ones', PID, list);
  assert.ok(Array.isArray(out));
  const blocks = out as { type: string; text?: string }[];
  assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
  assert.match(blocks[0].text!, /attached 2 images/);
  assert.ok(blocks[0].text!.includes(list[0].file) && blocks[0].text!.includes(list[1].file), 'the two oldest go by path');
  assert.ok(!blocks[0].text!.includes(list[2].file) && !blocks[0].text!.includes(list[3].file), 'the two newest are inline');
});

test('prompt: a missing file is skipped, not an error', () => {
  const ghost: Attachment = { id: 'att_aaaaaaaaaaaa', file: 'att_aaaaaaaaaaaa.png', type: 'image/png', size: 1, by: 'you', ts: '' };
  assert.equal(content.userContent('hi', PID, [ghost]), 'hi');
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });
assert.equal(failed, 0, `${failed} attachment case(s) failed`);
console.log(`\nall ${passed} attachment cases pass`);
