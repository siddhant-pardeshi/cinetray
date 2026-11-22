'use strict';

// Generates docs/walkthrough.vtt from the narration WAV durations + script
// texts, so the video has seekable captions for every section.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NAMES = [
  ['01-intro', 'Meet CineTray'],
  ['02-problem', 'Why it exists'],
  ['03-install', 'Install in Chrome'],
  ['04-first-drag', 'The gesture'],
  ['05-dock', 'The dock'],
  ['06-middrag', 'Create a playlist mid-drag'],
  ['07-cancel', 'Cancel and undo'],
  ['08-chip', 'The hover chip'],
  ['09-rightclick', 'Right-click saving'],
  ['10-player', 'Player long-press'],
  ['11-dashboard', 'The dashboard'],
  ['12-popup', 'Popup and badge'],
  ['13-privacy', 'Privacy'],
  ['14-outro', 'Outro']
];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ts = sec => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
};

let out = 'WEBVTT\n\n';
let cursor = 0.5; // narration starts 0.5s into each segment

NAMES.forEach(([name, title], i) => {
  const wav = path.join(__dirname, 'narr', name + '.wav');
  const txt = fs.readFileSync(path.join(__dirname, 'script', name + '.txt'), 'utf8').trim();
  const dur = parseFloat(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', wav
  ]).toString().trim());
  const segment = i + 1 === NAMES.length ? dur + 0.8 : dur + 1.3;

  out += `${i + 1}\n`;
  out += `${ts(cursor)} --> ${ts(cursor + dur)}\n`;
  out += `[${title}]\n${txt}\n\n`;
  cursor += segment;
});

fs.writeFileSync(path.join(ROOT, 'docs', 'walkthrough.vtt'), out);
console.log('walkthrough.vtt written, ends at', ts(cursor));
