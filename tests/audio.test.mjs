import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processAll, probe } from '../scripts/process-audio.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rd-audio-'));
  await cp(path.join(ROOT, 'data'), path.join(dir, 'data'), { recursive: true });
  await mkdir(path.join(dir, 'audio/lossless'), { recursive: true });
  return dir;
}
// A synthetic master. Stands in for a real FLAC export: 24-bit / 48 kHz stereo.
// Pink noise on purpose: a pure sine compresses to almost nothing in FLAC, unlike real music.
async function makeMaster(file, secs = 6) {
  await run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:seed=1:duration=${secs}:sample_rate=48000`,
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:seed=2:duration=${secs}:sample_rate=48000`,
    '-filter_complex', '[0][1]amerge=inputs=2', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', file]);
}

test('a FLAC master produces High and Data saver MP3s and real specs in the catalogue', async () => {
  const root = await setup();
  await makeMaster(path.join(root, 'audio/lossless/akdan.flac'));
  const s = await processAll({ root, log: () => {} });
  assert.equal(s.processed.length, 2);

  const cat = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
  const t = cat.tracks.find((x) => x.id === 'akdan');
  assert.equal(t.audio.lossless.format, 'FLAC');
  assert.equal(t.audio.lossless.bitDepth, 24);
  assert.equal(t.audio.lossless.sampleRate, 48000);
  assert.equal(t.audio.high.format, 'MP3');
  assert.equal(t.audio.high.bitrateKbps, 320);
  assert.equal(t.audio.standard.bitrateKbps, 128);
  assert.ok(t.audio.high.bytes > t.audio.standard.bytes, '320 kbps file is bigger than 128 kbps');
  assert.ok(t.audio.lossless.bytes > t.audio.high.bytes, 'lossless is the biggest');
  assert.ok(Math.abs(t.durationSec - 6) <= 1);

  const hi = await probe(path.join(root, 'audio/high/akdan.mp3'));
  assert.equal(hi.codec, 'mp3');
  assert.equal(hi.sampleRate, 44100, 'high-res source is resampled for the lossy tiers only');
  const flac = await probe(path.join(root, 'audio/lossless/akdan.flac'));
  assert.equal(flac.sampleRate, 48000, 'the lossless file itself is untouched');
  await rm(root, { recursive: true, force: true });
});

test('running again does no re-encoding, and a new master with no catalogue entry gets a stub', async () => {
  const root = await setup();
  await makeMaster(path.join(root, 'audio/lossless/akdan.flac'), 3);
  await processAll({ root, log: () => {} });
  const again = await processAll({ root, log: () => {} });
  assert.equal(again.processed.length, 0);
  assert.equal(again.skipped.length, 2);

  await makeMaster(path.join(root, 'audio/lossless/my-new-song.flac'), 3);
  const s = await processAll({ root, log: () => {} });
  assert.equal(s.processed.length, 2, 'only the new song is encoded');
  const cat = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
  const stub = cat.tracks.find((x) => x.id === 'my-new-song');
  assert.equal(stub.title, 'My New Song');
  assert.ok(stub.audio.lossless.src.endsWith('my-new-song.flac'));
  await rm(root, { recursive: true, force: true });
});

test('deleting a master removes dead references instead of leaving broken links', async () => {
  const root = await setup();
  await makeMaster(path.join(root, 'audio/lossless/akdan.flac'), 3);
  await processAll({ root, log: () => {} });
  await rm(path.join(root, 'audio/lossless/akdan.flac'));
  await rm(path.join(root, 'audio/high/akdan.mp3'));
  await rm(path.join(root, 'audio/standard/akdan.mp3'));
  const s = await processAll({ root, log: () => {} });
  assert.equal(s.removed.length, 3);
  const cat = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
  assert.deepEqual(cat.tracks.find((x) => x.id === 'akdan').audio, {});
  await rm(root, { recursive: true, force: true });
});
