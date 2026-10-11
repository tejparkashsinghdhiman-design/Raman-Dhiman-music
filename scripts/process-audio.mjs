#!/usr/bin/env node
// Turns lossless masters in audio/lossless/ into the High (MP3 320) and Data saver (MP3 128) versions,
// reads their real sound details with ffprobe, and keeps data/catalog.json in step.
//
//   node scripts/process-audio.mjs            process everything
//
// Requires ffmpeg and ffprobe on the PATH (GitHub's ubuntu runners get them from the workflow).
import { readdir, readFile, writeFile, stat, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTrack, fingerprint } from '../js/merge.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOSSLESS_EXT = /\.(flac|wav)$/i;
const TIERS = [
  { key: 'high', dir: 'audio/high', kbps: 320 },
  { key: 'standard', dir: 'audio/standard', kbps: 128 },
];
const exists = (p) => access(p).then(() => true, () => false);
const titleFromSlug = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw new Error(`No audio stream in ${file}`);
  const depth = parseInt(a.bits_per_raw_sample, 10) || parseInt(a.bits_per_sample, 10) || null;
  return {
    duration: parseFloat((j.format && j.format.duration) || a.duration) || 0,
    sampleRate: parseInt(a.sample_rate, 10) || null,
    bitDepth: depth,
    codec: a.codec_name,
    channels: a.channels || null,
  };
}

export async function encodeMp3(src, dst, kbps, meta = {}) {
  const args = ['-y', '-v', 'error', '-i', src, '-vn', '-map_metadata', '-1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-id3v2_version', '3'];
  if (meta.title) args.push('-metadata', `title=${meta.title}`);
  if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
  args.push(dst);
  await run('ffmpeg', args, { maxBuffer: 1 << 26 });
}

export async function processAll({ root = path.resolve(HERE, '..'), log = console.log } = {}) {
  const catPath = path.join(root, 'data/catalog.json');
  const catalog = JSON.parse(await readFile(catPath, 'utf8'));
  const before = fingerprint(catalog);
  const dir = path.join(root, 'audio/lossless');
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter((f) => LOSSLESS_EXT.test(f)).sort();
  const seen = new Set();
  const summary = { processed: [], skipped: [], removed: [] };

  for (const file of files) {
    const id = path.basename(file, path.extname(file)).toLowerCase();
    seen.add(id);
    const abs = path.join(dir, file);
    const bytes = (await stat(abs)).size;
    let track = catalog.tracks.find((t) => t.id === id);
    if (!track) {
      track = ensureTrack({ id, title: titleFromSlug(id), type: 'Single', year: new Date().getFullYear(), releaseDate: null, durationSec: null, source: 'Added from audio/lossless' });
      catalog.tracks.push(track);
      log(`+ new catalog entry for "${id}". Edit its title and details in data/catalog.json.`);
    }
    ensureTrack(track);
    const info = await probe(abs);
    track.audio.lossless = {
      src: `audio/lossless/${file}`, format: info.codec === 'flac' ? 'FLAC' : 'WAV',
      sampleRate: info.sampleRate, bitDepth: info.bitDepth, channels: info.channels, bytes,
    };
    if (!track.durationSec || Math.abs(track.durationSec - info.duration) > 1.5) track.durationSec = Math.round(info.duration);

    for (const t of TIERS) {
      const outDir = path.join(root, t.dir);
      await mkdir(outDir, { recursive: true });
      const outRel = `${t.dir}/${id}.mp3`;
      const outAbs = path.join(root, outRel);
      const prev = track.audio[t.key];
      const fresh = (await exists(outAbs)) && prev && prev.sourceBytes === bytes && prev.bitrateKbps === t.kbps;
      if (!fresh) {
        log(`encoding ${id} -> ${t.key} (MP3 ${t.kbps} kbps)`);
        await encodeMp3(abs, outAbs, t.kbps, { title: track.title, artist: (track.artists || ['Raman Dhiman']).join(', ') });
        summary.processed.push(`${id}:${t.key}`);
      } else summary.skipped.push(`${id}:${t.key}`);
      track.audio[t.key] = { src: outRel, format: 'MP3', bitrateKbps: t.kbps, bytes: (await stat(outAbs)).size, sourceBytes: bytes };
    }
  }

  // A master that was deleted should not leave dead links behind.
  for (const track of catalog.tracks) {
    if (seen.has(track.id) || !track.audio) continue;
    for (const k of ['lossless', 'high', 'standard']) {
      const e = track.audio[k];
      if (e && e.src && e.src.startsWith('audio/') && !(await exists(path.join(root, e.src)))) {
        delete track.audio[k];
        summary.removed.push(`${track.id}:${k}`);
        log(`- removed missing ${k} file reference for "${track.id}"`);
      }
    }
  }

  if (fingerprint(catalog) !== before) {
    catalog.generatedAt = new Date().toISOString();
    await writeFile(catPath, JSON.stringify(catalog, null, 2) + '\n');
    log('catalog updated');
  } else log('catalog already up to date');
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  processAll().then((s) => log(s)).catch((e) => { console.error(e); process.exit(1); });
  function log(s) { console.log(typeof s === 'string' ? s : `done: ${s.processed.length} encoded, ${s.skipped.length} unchanged, ${s.removed.length} references removed`); }
}
