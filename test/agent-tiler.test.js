'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolvePython, runProcess } = require('../src/python.js');

test('critic tiles label temporal panels without drawing into resized frame pixels', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-tiler-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frames = path.join(root, 'frames'), out = path.join(root, 'out'), python = await resolvePython();
  const make = await runProcess(python.command, ['-c',
    'from pathlib import Path; from PIL import Image,ImageDraw; import sys\np=Path(sys.argv[1]);p.mkdir()\nfor i,c in enumerate([(210,40,40),(40,180,60),(40,90,220),(210,150,30)]):\n im=Image.new("RGB",(800,1000),c); d=ImageDraw.Draw(im); d.rectangle((40+i*20,400,260+i*20,610),fill=(255,255,255)); d.line((0,i*100,799,i*100),fill=(0,0,0),width=3); im.save(p/f"frame_{i:04d}.png")', frames]);
  assert.equal(make.code, 0, make.stderr);
  const tiled = await runProcess(python.command, [path.join(__dirname, '../src/agent/tile-frames.py'), '--frames-dir', frames, '--out', out]);
  assert.equal(tiled.code, 0, tiled.stderr);
  const images = JSON.parse(tiled.stdout).images;
  assert.deepEqual(images.map(file => path.basename(file)), ['frames-01.png', 'frames-23.png', 'seam.png']);
  const verify = await runProcess(python.command, ['-c',
    'from pathlib import Path; from PIL import Image,ImageChops; import sys\nsheet=Image.open(sys.argv[1]).convert("RGB"); a=Image.open(sys.argv[2]).convert("RGB").resize((768,960),Image.Resampling.LANCZOS); b=Image.open(sys.argv[3]).convert("RGB").resize((768,960),Image.Resampling.LANCZOS)\nassert sheet.size==(1552,988),sheet.size\nassert ImageChops.difference(sheet.crop((0,28,768,988)),a).getbbox() is None\nassert ImageChops.difference(sheet.crop((784,28,1552,988)),b).getbbox() is None\nassert set(sheet.crop((768,0,784,988)).getdata())=={(215,221,226)}\nheader=Image.new("RGB",(768,28),(238,241,243)); assert ImageChops.difference(sheet.crop((0,0,768,28)),header).getbbox() is not None\nfor name in ["frames-01.png","frames-23.png","seam.png"]:\n p=Path(sys.argv[4])/name; im=Image.open(p); assert im.width<=1568 and im.height<=1568; assert p.stat().st_size<=3000000\nprint("verified")',
    path.join(out, 'frames-01.png'), path.join(frames, 'frame_0000.png'), path.join(frames, 'frame_0001.png'), out]);
  assert.equal(verify.code, 0, verify.stderr);
});
