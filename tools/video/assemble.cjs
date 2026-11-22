'use strict';

// Builds docs/walkthrough.mp4: one segment per slide (slow Ken Burns zoom,
// dip-to-black fades) with its narration clip padded to fill the segment.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const V = path.join(__dirname);
const SLIDES = path.join(V, 'slides');
const NARR = path.join(V, 'narr');
const SEGS = path.join(V, 'segs');
const OUT = path.join(ROOT, 'docs', 'walkthrough.mp4');

const NARRATION = [
  '01-intro', '02-problem', '03-install', '04-first-drag', '05-dock',
  '06-middrag', '07-cancel', '08-chip', '09-rightclick', '10-player',
  '11-dashboard', '12-popup', '13-privacy', '14-outro'
];

function durationOf(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file
  ]).toString().trim();
  return parseFloat(out);
}

function main() {
  fs.mkdirSync(SEGS, { recursive: true });
  const entries = [];

  NARRATION.forEach((name, i) => {
    const slide = path.join(SLIDES, `slide-${String(i + 1).padStart(2, '0')}.png`);
    const wav = path.join(NARR, name + '.wav');
    if (!fs.existsSync(slide) || !fs.existsSync(wav)) {
      throw new Error('missing input for ' + name);
    }
    const narrDur = durationOf(wav);
    const dur = Math.max(4, narrDur + 1.3);
    const frames = Math.round(dur * 30);
    const fadeOutStart = Math.max(0.2, dur - 0.6).toFixed(2);

    // alternate a slow push-in and pull-back so the slideshow breathes
    const zoom = i % 2 === 0
      ? "z='min(zoom+0.0011,1.10)'"
      : "z='if(lte(on,1),1.10,max(zoom-0.0011,1.0))'";

    const seg = path.join(SEGS, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
    const vf = [
      `scale=1280:720`,
      `zoompan=${zoom}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=30`,
      `fade=t=in:st=0:d=0.45`,
      `fade=t=out:st=${fadeOutStart}:d=0.6`,
      `format=yuv420p`
    ].join(',');

    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-i', slide,
      '-i', wav,
      '-filter_complex',
        `[0:v]${vf}[v];[1:a]adelay=500,aresample=48000,apad[a]`,
      '-map', '[v]', '-map', '[a]',
      '-t', dur.toFixed(2),
      '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      seg
    ]);
    console.log(`seg ${i + 1}/14  ${dur.toFixed(1)}s  (${name})`);
    entries.push(`file '${seg.replace(/\\/g, '/')}'`);
  });

  const listFile = path.join(SEGS, 'list.txt');
  fs.writeFileSync(listFile, entries.join('\n'));

  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart',
    OUT
  ]);

  const total = durationOf(OUT);
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`WALKTHROUGH BUILT: ${OUT}`);
  console.log(`duration ${total.toFixed(1)}s  size ${mb} MB`);
}

main();
