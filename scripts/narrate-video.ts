// narrate-video — adds an AI voice-over to the fallback demo video, one spoken line per caption cue.
// Usage: TTS_CMD='<command>' node scripts/narrate-video.ts
// Reads docs/media/demo-rough-cut.mp4 + demo-rough-cut.srt, writes docs/media/demo-rough-cut-narrated.mp4.
//
// TTS_CMD is any shell command that reads one line of text on stdin and writes a WAV file to "$OUT".
// The narrated cut in the repo was made with Piper (https://github.com/rhasspy/piper), voice en_US-ryan-high:
//   python3 -m venv /tmp/piper && /tmp/piper/bin/pip install piper-tts
//   V=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high
//   curl -L -o /tmp/ryan.onnx $V/en_US-ryan-high.onnx && curl -L -o /tmp/ryan.onnx.json $V/en_US-ryan-high.onnx.json
//   TTS_CMD='/tmp/piper/bin/piper -m /tmp/ryan.onnx -f "$OUT" 2>/dev/null' node scripts/narrate-video.ts
//
// Fitting: each clip has its edge silence trimmed and starts at its cue's start. A clip longer than the cue
// is sped up with atempo (at most 1.25×); it may run past the cue's end into the gap, but never past the
// next cue's start (or the end of the video). A line that still does not fit is merged with the next cue and
// spoken as one clip across both; if even that fails, the run fails.
// The clips are mixed into one track, loudness-normalised to -16 LUFS, and muxed with the video stream copied.
// Intermediate files go to .out/narration/ (gitignored). Prints a per-cue fit table.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MEDIA = 'docs/media';
const IN_MP4 = join(MEDIA, 'demo-rough-cut.mp4');
const IN_SRT = join(MEDIA, 'demo-rough-cut.srt');
const OUT_MP4 = join(MEDIA, 'demo-rough-cut-narrated.mp4');
const WORK = resolve('.out/narration');
const MAX_TEMPO = 1.25;
const GUARD = 0.05; // seconds of silence kept before the next cue
const RATE = 48000;

// Spoken forms for what a TTS engine reads badly. Captions keep the written form.
const SAY: [RegExp, string][] = [
  [/gCO₂e/g, 'grams of CO2 equivalent'],
  [/\bMR\b/g, 'M R'],
  [/\b404\b/g, 'four oh four'],
];

interface Cue {
  n: number;
  start: number;
  end: number;
  text: string;
}

function seconds(ts: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(ts);
  if (!m) throw new Error(`bad SRT timestamp: ${ts}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function parseSrt(src: string): Cue[] {
  return src
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const [n, times, ...text] = block.split('\n');
      const [a, b] = times.split('-->');
      return { n: Number(n), start: seconds(a), end: seconds(b), text: text.join(' ').trim() };
    });
}

function spoken(text: string): string {
  let s = text;
  for (const [re, to] of SAY) s = s.replace(re, to);
  return s;
}

function duration(file: string): number {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(out.toString().trim());
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

const TRIM =
  'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse';

function main(): void {
  const tts = process.env.TTS_CMD;
  if (!tts) {
    console.error('TTS_CMD is not set; see the header of scripts/narrate-video.ts');
    process.exit(2);
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const videoLen = duration(IN_MP4);
  const cues = parseSrt(readFileSync(IN_SRT, 'utf8'));
  const rows: string[] = [];
  const clips: { file: string; at: number }[] = [];
  let failures = 0;

  // Synthesise, speed up and measure one clip covering cues[i..j] (one cue unless a line had to be merged).
  const fitClip = (i: number, j: number) => {
    const id = i === j ? `${cues[i].n}` : `${cues[i].n}-${cues[j].n}`;
    const raw = join(WORK, `cue-${id}-raw.wav`);
    const trimmed = join(WORK, `cue-${id}-trim.wav`);
    const file = join(WORK, `cue-${id}.wav`);
    const text = cues
      .slice(i, j + 1)
      .map((c) => c.text)
      .join(' ');
    execSync(tts, {
      input: `${spoken(text)}\n`,
      env: { ...process.env, OUT: raw },
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    ffmpeg(['-i', raw, '-af', TRIM, '-ar', String(RATE), '-ac', '1', trimmed]);
    const speech = duration(trimmed);
    const window = cues[j].end - cues[i].start;
    const slot = (j + 1 < cues.length ? cues[j + 1].start : videoLen) - cues[i].start - GUARD;
    const tempo = Math.min(MAX_TEMPO, Math.max(1, speech / window));
    ffmpeg(['-i', trimmed, '-af', tempo > 1 ? `atempo=${tempo.toFixed(4)}` : 'anull', file]);
    const placed = duration(file);
    return { id, file, at: cues[i].start, speech, window, slot, tempo, placed, fits: placed <= slot + 0.01 };
  };

  // A line that cannot fit even at MAX_TEMPO is merged with the next cue (one sentence split over two
  // captions) and spoken as one clip across both windows, instead of exceeding the tempo cap or overlapping.
  for (let i = 0; i < cues.length; ) {
    let j = i;
    let clip = fitClip(i, j);
    while (!clip.fits && j + 1 < cues.length) clip = fitClip(i, ++j);
    if (!clip.fits) failures++;
    const status = !clip.fits
      ? 'FAIL overlaps next cue'
      : `${clip.placed <= clip.window ? 'in window' : 'runs into gap'}${i === j ? '' : ' (merged)'}`;
    rows.push(
      [
        clip.id.padStart(5),
        clip.at.toFixed(2).padStart(7),
        clip.window.toFixed(2).padStart(6),
        clip.slot.toFixed(2).padStart(6),
        clip.speech.toFixed(2).padStart(6),
        `${clip.tempo.toFixed(2)}x`.padStart(6),
        clip.placed.toFixed(2).padStart(6),
        status,
      ].join('  '),
    );
    clips.push(clip);
    i = j + 1;
  }

  console.log('  cue    start  window    slot  speech   tempo  placed  fit');
  for (const r of rows) console.log(r);
  if (failures > 0) {
    console.error(
      `${failures} cue(s) do not fit even at ${MAX_TEMPO}x; shorten the lines in scripts/render-video.ts`,
    );
    process.exit(1);
  }

  // Mix: each clip delayed to its cue start, summed, padded to the video length, normalised to -16 LUFS.
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((c, k) => {
    const ms = Math.round(c.at * 1000);
    return `[${k}:a]adelay=${ms}|${ms}[d${k}]`;
  });
  const mix = `${clips.map((_, k) => `[d${k}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad=whole_dur=${videoLen},atrim=0:${videoLen}[m]`;
  const track = join(WORK, 'narration.wav');
  ffmpeg([
    ...inputs,
    '-filter_complex',
    [...delays, mix].join(';'),
    '-map',
    '[m]',
    '-ar',
    String(RATE),
    track,
  ]);
  ffmpeg([
    '-i',
    track,
    '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar',
    String(RATE),
    join(WORK, 'narration-norm.wav'),
  ]);

  ffmpeg([
    '-i',
    IN_MP4,
    '-i',
    join(WORK, 'narration-norm.wav'),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-t',
    String(videoLen),
    '-movflags',
    '+faststart',
    OUT_MP4,
  ]);
  const mb = statSync(OUT_MP4).size / 1e6;
  console.log(
    `wrote ${OUT_MP4}: ${duration(OUT_MP4).toFixed(1)} s, ${mb.toFixed(1)} MB, ${cues.length} narrated cues`,
  );
}

main();
