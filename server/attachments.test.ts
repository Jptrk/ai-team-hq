/**
 * Pasted images: type sniffing, file names, picking ids, the sweep, and the prompt blocks and their caps.
 * Desk images: screenshots held in memory and saved only when attached, and image files attached by path.
 * Report paths: links inside a desk's reports/ never lead out of it.
 * Run: npm run test:attachments. Works in a throwaway folder under the OS temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, State } from '../shared/types';
import type { Shots } from './runner/screenshots';

// The store reads data/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-attach-'));
process.chdir(root);
const att = await import('./attachments');
const content = await import('./runner/content');
const shotsMod = await import('./runner/screenshots');
const claude = await import('./runner/claude');
const PID = 'demo';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

let passed = 0;
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

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

// ---------- desk screenshots ----------
const toolUse = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id: string, blocks: unknown[]) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: blocks }] } });
const imgBlock = (buf: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } });

test('screenshots: images from a connection are found, HQ tools and file reads are not', () => {
  const byId = new Map<string, string>();
  for (const m of [toolUse('t1', 'mcp__figma__get_screenshot'), toolUse('t2', 'Read'), toolUse('t3', 'mcp__hq__comment_on_ticket')]) for (const [id, name] of shotsMod.toolUsesIn(m)) byId.set(id, name);
  assert.equal(byId.size, 3);
  const found = shotsMod.toolImagesIn(toolResult('t1', [{ type: 'text', text: 'here' }, imgBlock(PNG)]), byId);
  assert.equal(found.length, 1);
  assert.equal(found[0].tool, 'mcp__figma__get_screenshot');
  assert.ok(found[0].data.equals(PNG));
  assert.equal(shotsMod.toolImagesIn(toolResult('t2', [imgBlock(PNG)]), byId).length, 0, 'a file the desk read is not a screenshot');
  assert.equal(shotsMod.toolImagesIn(toolResult('t3', [imgBlock(PNG)]), byId).length, 0, 'HQ tools never count');
  assert.equal(shotsMod.toolImagesIn(toolResult('unknown', [imgBlock(PNG)]), byId).length, 0);
  assert.equal(shotsMod.toolImagesIn(toolUse('t1', 'x'), byId).length, 0, 'assistant messages carry no results');
  assert.equal(shotsMod.toolImagesIn({ type: 'user', message: { content: 'plain prompt' } }, byId).length, 0);
});

const newShots = (): Shots => ({ recent: [], pending: new Set() });
const fig = (data: Buffer) => ({ tool: 'mcp__figma__get_screenshot', data });
/** PNGs that differ, so a test can tell which one was saved. */
const pngNo = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);
const fileCount = () => (fs.existsSync(att.attachmentsDir(PID)) ? fs.readdirSync(att.attachmentsDir(PID)).length : 0);
const saveAsLeo = (data: Buffer) => att.saveUpload(PID, data, 'leo');
const noFiles = () => 'files were not expected here';

test('screenshots: held in memory, newest 6 kept; junk and too-large data are skipped with a reason', () => {
  const before = fileCount();
  const shots = newShots();
  shotsMod.keepShots(shots, [fig(PNG)]);
  assert.equal(shots.recent.length, 1);
  assert.equal(fileCount(), before, 'taking a screenshot writes nothing');
  shotsMod.keepShots(shots, [{ tool: 'mcp__x__y', data: HTML }]);
  assert.equal(shots.recent.length, 1);
  assert.match(shots.skipped ?? '', /not kept: it is not a PNG/);
  shotsMod.keepShots(shots, [fig(Buffer.concat([PNG, Buffer.alloc(3_800_000)]))]);
  assert.match(shots.skipped ?? '', /3.75 MB/);
  shotsMod.keepShots(shots, [fig(JPEG)]);
  assert.equal(shots.skipped, undefined, 'a good capture clears the reason');
  // Past six the oldest drops; the newest is never refused.
  const seven = Array.from({ length: 7 }, (_, i) => fig(pngNo(i)));
  shotsMod.keepShots(shots, seven);
  assert.equal(shots.recent.length, 6);
  assert.ok(shots.recent[0].data.equals(seven[1].data));
  assert.ok(shots.recent[5].data.equals(seven[6].data));
  assert.equal(fileCount(), before);
});

test('screenshots: attach the latest N, saved only then, and the reply can name the source', () => {
  assert.match(String(shotsMod.deskImages({ screenshots: 1 }, newShots(), noFiles, saveAsLeo)), /No screenshot was taken/);
  const shots = newShots();
  shotsMod.keepShots(shots, [fig(pngNo(1)), fig(pngNo(2)), { tool: 'mcp__claude_ai_Figma__get_screenshot', data: pngNo(3) }]);
  const before = fileCount();
  const latest = shotsMod.deskImages({ screenshots: 1 }, shots, noFiles, saveAsLeo);
  assert.ok(typeof latest !== 'string');
  assert.equal(latest.count, 1);
  assert.deepEqual(latest.sources, ['Figma get_screenshot']);
  assert.equal(fileCount(), before, 'checking writes nothing');
  const [saved] = latest.save();
  assert.equal(saved.by, 'leo');
  assert.ok(fs.readFileSync(path.join(att.attachmentsDir(PID), saved.file)).equals(pngNo(3)), 'the newest screenshot is the one saved');
  assert.equal(fileCount(), before + 1, 'only the attached one is written');
  const two = shotsMod.deskImages({ screenshots: 2 }, shots, noFiles, saveAsLeo);
  assert.ok(typeof two !== 'string' && two.count === 2);
  assert.deepEqual(two.sources, ['figma get_screenshot', 'Figma get_screenshot']);
  const nothing = shotsMod.deskImages({}, shots, noFiles, saveAsLeo);
  assert.ok(typeof nothing !== 'string' && nothing.count === 0 && nothing.save().length === 0, 'nothing asked, nothing attached');
  // Too many in total: refused before any file is checked.
  const full = newShots();
  shotsMod.keepShots(full, Array.from({ length: 6 }, (_, i) => fig(pngNo(i))));
  let checked = false;
  const attach = () => {
    checked = true;
    return noFiles();
  };
  assert.match(String(shotsMod.deskImages({ screenshots: 6, files: ['x.png'] }, full, attach, saveAsLeo)), /at most 6/);
  assert.equal(checked, false);
});

test('screenshots: when the newest capture was refused, an older one is never attached in its place', () => {
  const shots = newShots();
  shotsMod.keepShots(shots, [fig(PNG), fig(HTML)]);
  assert.equal(shots.recent.length, 1, 'the older good one is still held');
  const before = fileCount();
  assert.match(String(shotsMod.deskImages({ screenshots: 1 }, shots, noFiles, saveAsLeo)), /latest screenshot \(from figma get_screenshot\) was not kept/);
  assert.equal(fileCount(), before);
  // Files alone still go: the refused capture only blocks screenshots.
  const ready = { count: 1, sources: ['mock.png'], save: () => [] };
  const files = shotsMod.deskImages({ files: ['mock.png'] }, shots, () => ready, saveAsLeo);
  assert.ok(typeof files !== 'string' && files.count === 1);
});

test('screenshots: a call waits for a capture still on its way, and gives up after the timeout', async () => {
  const shots = newShots();
  assert.equal(await shotsMod.waitForShots(shots, 100), true, 'nothing pending, no wait');
  shots.pending.add('t1');
  const started = Date.now();
  setTimeout(() => shots.pending.delete('t1'), 60);
  assert.equal(await shotsMod.waitForShots(shots, 1000), true);
  assert.ok(Date.now() - started >= 50, 'it waited for the result');
  shots.pending.add('t2');
  assert.equal(await shotsMod.waitForShots(shots, 80), false, 'still pending after the timeout');
});

test('screenshots: every tool result clears its call, with or without an image', () => {
  assert.deepEqual(shotsMod.toolResultIdsIn(toolResult('t1', [{ type: 'text', text: 'no image' }])), ['t1']);
  assert.deepEqual(shotsMod.toolResultIdsIn(toolResult('t2', [imgBlock(PNG)])), ['t2']);
  assert.deepEqual(shotsMod.toolResultIdsIn(toolUse('t1', 'mcp__figma__get_screenshot')), [], 'assistant messages carry no results');
});

test('screenshots: image files a desk can read attach; anything else is refused, and nothing is copied until all pass', () => {
  const ws = path.join(root, 'ws-leo');
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, 'mock.png'), PNG);
  fs.writeFileSync(path.join(ws, 'fake.png'), HTML);
  fs.writeFileSync(path.join(ws, 'big.png'), Buffer.concat([PNG, Buffer.alloc(3_800_000)]));
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  const roots = [ws, att.attachmentsDir(PID)];
  const ok = shotsMod.attachFiles(PID, 'leo', ['mock.png'], roots, ws);
  assert.ok(typeof ok !== 'string' && ok.count === 1);
  assert.deepEqual(ok.sources, ['mock.png']);
  const before = fileCount();
  const [copied] = ok.save();
  assert.equal(fileCount(), before + 1);
  assert.ok(copied.by === 'leo' && copied.type === 'image/png');
  assert.notEqual(copied.file, 'mock.png', 'copied in under a server name');
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['fake.png'], roots, ws)), /not a PNG/);
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['big.png'], roots, ws)), /3.75 MB/);
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['missing.png'], roots, ws)), /does not exist/);
  assert.match(String(shotsMod.attachFiles(PID, 'leo', [path.join(outside, 'secret.png')], roots, ws)), /outside/);
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['../elsewhere/secret.png'], roots, ws)), /outside/);
  // One bad file in the list: the good one before it is not copied either.
  const mid = fileCount();
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['mock.png', 'fake.png'], roots, ws)), /not a PNG/);
  assert.equal(fileCount(), mid);
  const twice = shotsMod.attachFiles(PID, 'leo', ['mock.png', path.join(ws, 'mock.png')], roots, ws);
  assert.ok(typeof twice !== 'string' && twice.count === 1, 'the same file named twice goes once');
  // An existing attachment is reused, not copied again.
  const existing = att.saveUpload(PID, PNG, 'you');
  const again = shotsMod.attachFiles(PID, 'leo', [path.join(att.attachmentsDir(PID), existing.file)], roots, ws);
  assert.ok(typeof again !== 'string');
  const n = fileCount();
  assert.equal(again.save()[0].id, existing.id);
  assert.equal(fileCount(), n);
});

test('screenshots: a link inside a readable folder that points outside is refused', () => {
  const ws = path.join(root, 'ws-link');
  const outside = path.join(root, 'outside-link');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  fs.writeFileSync(path.join(ws, 'mine.png'), PNG);
  try {
    fs.symlinkSync(outside, path.join(ws, 'linked'), 'junction');
  } catch (e) {
    console.log(`     (link case skipped: ${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  assert.match(String(shotsMod.attachFiles(PID, 'leo', ['linked/secret.png'], [ws], ws)), /outside/);
  assert.ok(typeof shotsMod.attachFiles(PID, 'leo', ['mine.png'], [ws], ws) !== 'string', 'real files beside the link still attach');
});

test('reports: a link inside reports/ that points outside is refused', () => {
  const reports = path.join(claude.workspaceFor(PID, 'leo'), 'reports');
  const outside = path.join(root, 'outside-reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
  fs.writeFileSync(path.join(reports, 'plan.md'), '# plan');
  assert.equal(claude.resolveReport(PID, 'leo', 'plan.md'), path.join(reports, 'plan.md'));
  assert.equal(claude.resolveReport(PID, 'leo', '../memory.md'), null, 'the text check still applies');
  try {
    fs.symlinkSync(outside, path.join(reports, 'linked'), 'junction');
  } catch (e) {
    console.log(`     (link case skipped: ${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  assert.equal(claude.resolveReport(PID, 'leo', 'linked/secret.md'), null);
  assert.equal(claude.resolveReport(PID, 'leo', 'linked'), null, 'the link itself too');
  assert.equal(claude.resolveReport(PID, 'leo', 'plan.md'), path.join(reports, 'plan.md'), 'real reports beside the link still resolve');
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
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
