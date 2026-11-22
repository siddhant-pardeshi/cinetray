'use strict';

// Builds docs/walkthrough.mp4 v2: live motion segments (from tools/video/caps)
// interleaved with designed slides, all with burned-in captions, chapter
// kickers, a progress bar, and Zira narration padded to fill each segment.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const V = __dirname;
const SLIDES = path.join(V, 'slides');
const CAPS = path.join(V, 'caps');
const NARR = path.join(V, 'narr');
const SEGS = path.join(V, 'segs');
const FONTS = path.join(V, 'fonts');
const OUT = path.join(ROOT, 'docs', 'walkthrough.mp4');

const SEGMENTS = [
  { id: '01', narr: '01-intro',     slide: 'slide-01.png', kicker: 'MEET CINETRAY',      caption: 'Collect YouTube videos with a single drag' },
  { id: '02', narr: '02-problem',   slide: 'slide-02.png', kicker: 'WHY IT EXISTS',       caption: 'Three clicks become one gesture' },
  { id: '03', narr: '03-install',   caps: '01-install',    kicker: 'INSTALL',             caption: 'chrome://extensions, Developer mode, Load unpacked' },
  { id: '04', narr: '04-first-drag', caps: '03-drag',      kicker: 'THE GESTURE',         caption: 'Press and move: the video lifts, the dock slides in' },
  { id: '05', narr: '05-dock',      caps: '04-dock',       kicker: 'THE DOCK',            caption: 'A well for Watch Later and every playlist' },
  { id: '06', narr: '06-middrag',   caps: '05-middrag',    kicker: 'CREATE MID-DRAG',     caption: 'Type a name in the dashed well, press Enter' },
  { id: '07', narr: '07-cancel',    caps: '06-escape',     kicker: 'CANCEL + UNDO',       caption: 'Escape cancels; Undo in the toast' },
  { id: '08', narr: '08-chip',      caps: '02-chip',       kicker: 'HOVER CHIP',          caption: 'One click on the card saves to Watch Later' },
  { id: '09', narr: '09-rightclick', slide: 'slide-09.png', kicker: 'RIGHT-CLICK',       caption: 'Right-click any video, choose CineTray' },
  { id: '10', narr: '10-player',    caps: '07-player',     kicker: 'PLAYER LONG-PRESS',   caption: 'Hold inside the player to lift the video' },
  { id: '11', narr: '11-dashboard', caps: '08-dashboard',  kicker: 'THE DASHBOARD',       caption: 'Browse, reorder, search, flip the dock side' },
  { id: '12', narr: '12-popup',     caps: '09-popup',      kicker: 'POPUP + BADGE',       caption: 'Create playlists right in the popup' },
  { id: '13', narr: '13-privacy',   slide: 'slide-13.png', kicker: 'PRIVACY',             caption: '100% local: chrome.storage, no servers' },
  { id: '14', narr: '14-outro',     slide: 'slide-14.png', kicker: 'THAT IS CINETRAY',    caption: 'github.com/siddhant-pardeshi/cinetray' }
];

const durationOf = file => parseFloat(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', file
]).toString().trim());

function ffmpeg(args) {
  try {
    execFileSync('ffmpeg', args);
  } catch (err) {
    console.error('FAILED COMMAND: ffmpeg ' + args.join(' '));
    console.error('STDERR:', err.stderr ? err.stderr.toString() : '(none)');
    throw err;
  }
}

// drawtext needs a plain font path and pre-escaped text; a literal % must
// survive filter parsing as \\% or drawtext's expansion eats it
function esc(text) {
  return text.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\\\%');
}
function setupFonts() {
  fs.mkdirSync(FONTS, { recursive: true });
  for (const f of ['segoeui.ttf', 'seguisb.ttf']) {
    const src = 'C:/Windows/Fonts/' + f;
    const dst = path.join(FONTS, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

function main() {
  fs.mkdirSync(SEGS, { recursive: true });
  setupFonts();
  const font = (path.join(FONTS, 'segoeui.ttf')).replace(/\\/g, '/');
  const fontBold = (path.join(FONTS, 'seguisb.ttf')).replace(/\\/g, '/');
  // quote the value AND escape the drive-letter colon; ffmpeg's filtergraph
  // splits on ':' before option-level quoting gets a say
  const fArg = v => `fontfile='${v.replace(/:/g, '\\:')}'`;
  const entries = [];
  let cursor = 0;
  const starts = {};

  SEGMENTS.forEach((seg, i) => {
    const wav = path.join(NARR, seg.narr + '.wav');
    const narrDur = durationOf(wav);
    const capsDir = seg.caps ? path.join(CAPS, seg.caps) : null;
    let dur;
    let videoFilter;

    if (capsDir) {
      const stamps = JSON.parse(fs.readFileSync(path.join(capsDir, 'stamps.json'), 'utf8'));
      dur = Math.max(narrDur + 1.2, stamps.dur + 0.35);

      // frame concat list: hold frame 0 through its timestamp, then real pacing
      const list = [];
      list.push(`file '${path.join(capsDir, 'f00000.jpg').replace(/\\/g, '/')}'`);
      list.push(`duration ${Math.max(0.05, stamps.ts[0]).toFixed(3)}`);
      for (let f = 1; f < stamps.count; f++) {
        list.push(`file '${path.join(capsDir, 'f' + String(f).padStart(5, '0') + '.jpg').replace(/\\/g, '/')}'`);
        list.push(`duration ${(stamps.ts[f] - stamps.ts[f - 1]).toFixed(3)}`);
      }
      list.push(`file '${path.join(capsDir, 'f' + String(stamps.count - 1).padStart(5, '0') + '.jpg').replace(/\\/g, '/')}'`);
      list.push(`duration ${(dur - stamps.ts[stamps.count - 1]).toFixed(3)}`);
      const listFile = path.join(SEGS, `frames-${seg.id}.txt`);
      fs.writeFileSync(listFile, list.join('\n'));

      const frac = ((i + 1) / SEGMENTS.length).toFixed(4);
      videoFilter = [
        'fps=30', 'scale=1280:720',
        `drawtext=${fArg(fontBold)}:text='${esc(seg.kicker)}':fontsize=15:fontcolor=0xE9EAF0:x=58:y=30:box=1:boxcolor=0x0A0A10A6:boxborderw=10`,
        `drawtext=${fArg(font)}:text='${esc(seg.caption)}':fontsize=30:fontcolor=white:x=58:y=636:box=1:boxcolor=0x0A0A10A6:boxborderw=16`,
        `drawbox=x=0:y=715:w=iw*${frac}:h=5:color=0xFF4D6D@0.9:t=fill`,
        'fade=t=in:st=0:d=0.4', `fade=t=out:st=${(dur - 0.55).toFixed(2)}:d=0.55`,
        'format=yuv420p'
      ].join(',');
    } else {
      const slide = path.join(SLIDES, seg.slide);
      dur = narrDur + 1.3;
      const frames = Math.round(dur * 30);
      const zoom = i % 2 === 0
        ? "z='min(zoom+0.0011,1.10)'"
        : "z='if(lte(on,1),1.10,max(zoom-0.0011,1.0))'";
      const frac = ((i + 1) / SEGMENTS.length).toFixed(4);
      videoFilter = [
        'scale=1280:720',
        `zoompan=${zoom}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=30`,
        `drawtext=${fArg(fontBold)}:text='${esc(seg.kicker)}':fontsize=15:fontcolor=0xE9EAF0:x=58:y=30:box=1:boxcolor=0x0A0A10A6:boxborderw=10`,
        `drawtext=${fArg(font)}:text='${esc(seg.caption)}':fontsize=30:fontcolor=white:x=58:y=636:box=1:boxcolor=0x0A0A10A6:boxborderw=16`,
        `drawbox=x=0:y=715:w=iw*${frac}:h=5:color=0xFF4D6D@0.9:t=fill`,
        'fade=t=in:st=0:d=0.45', `fade=t=out:st=${(dur - 0.6).toFixed(2)}:d=0.6`,
        'format=yuv420p'
      ].join(',');
    }

    const segFile = path.join(SEGS, `seg-${seg.id}.mp4`);
    ffmpeg([
      '-y', '-v', 'error',
      ...(capsDir
        ? ['-f', 'concat', '-safe', '0', '-i', path.join(SEGS, `frames-${seg.id}.txt`)]
        : ['-i', path.join(SLIDES, seg.slide)]),
      '-i', wav,
      '-filter_complex', `[0:v]${videoFilter}[v];[1:a]adelay=500,aresample=48000,apad[a]`,
      '-map', '[v]', '-map', '[a]',
      '-t', dur.toFixed(2), '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      segFile
    ]);
    starts[seg.id] = cursor;
    cursor += dur;
    entries.push(`file '${segFile.replace(/\\/g, '/')}'`);
    console.log(`seg ${seg.id}  ${dur.toFixed(1)}s  (${seg.narr}${capsDir ? ', motion' : ', slide'})`);
  });

  const listFile = path.join(SEGS, 'list.txt');
  fs.writeFileSync(listFile, entries.join('\n'));
  ffmpeg([
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart',
    OUT
  ]);

  const total = durationOf(OUT);
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  fs.writeFileSync(path.join(SEGS, 'starts.json'), JSON.stringify(starts, null, 1));

  // poster frame: mid-flight of the drag chapter
  const posterT = starts['04'] + 6.5;
  ffmpeg([
    '-y', '-v', 'error', '-ss', posterT.toFixed(1), '-i', OUT, '-frames:v', '1',
    '-q:v', '3', path.join(ROOT, 'docs', 'walkthrough-poster.jpg')
  ]);

  console.log(`WALKTHROUGH BUILT: ${OUT}`);
  console.log(`duration ${total.toFixed(1)}s  size ${mb} MB`);
}

main();
