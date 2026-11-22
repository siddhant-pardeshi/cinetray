'use strict';

// Isolate the drawtext filter parse failure.
const path = require('path');
const { execFileSync } = require('child_process');

const FONTS = path.join(__dirname, 'fonts');
const fontBold = (path.join(FONTS, 'seguisb.ttf')).replace(/\\/g, '/');
const font = (path.join(FONTS, 'segoeui.ttf')).replace(/\\/g, '/');
const fArg = v => `fontfile='${v.replace(/:/g, '\\:')}'`;
const esc = t => t;

const filter = 'scale=1280:720,drawtext=' + fArg(fontBold) +
  ":text='MEET CINETRAY':fontsize=15:fontcolor=0xE9EAF0:x=58:y=30:box=1:boxcolor=0x0A0A10A6:boxborderw=10,format=yuv420p";
console.log('filter:', filter);

try {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-i', 'slides/slide-01.png',
    '-filter_complex', '[0:v]' + filter + '[v]',
    '-map', '[v]', '-frames:v', '1', 'segs/filter-test.png'
  ], { cwd: __dirname });
  console.log('FILTER OK');
} catch (e) {
  console.log('STDERR:', e.stderr.toString().slice(0, 600));
}
