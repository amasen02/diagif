"""Decode GIFs and verify timing, seam, palette, and static-region stability."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageSequence


def delay_failures(delays, duration, step, strict=False):
    failures = []
    if not isinstance(step, int) or step <= 0 or duration <= 0 or duration % step:
        return ['duration must be a positive multiple of stepMs']
    expected = duration // step
    if any(d <= 0 or d % step for d in delays):
        failures.append('delays must be positive multiples of stepMs')
    if sum(delays) != duration:
        failures.append('delay sum does not equal expectedDurationMs')
    if not 1 <= len(delays) <= min(expected, 250):
        failures.append('frame count outside expected range or exceeds 250')
    if strict and len(delays) != expected:
        failures.append('strictFrameCount forbids merged frames')
    return failures


def nonzero(image):
    return image.point([0] + [255] * 255)


def channel_max(image):
    r, g, b = image.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def count_on(mask):
    return sum(mask.histogram()[1:])


def exact_count(rgb, color):
    mask = None
    for channel, value in zip(rgb.split(), color):
        lookup = [0] * 256
        lookup[value] = 255
        match = channel.point(lookup)
        mask = match if mask is None else ImageChops.darker(mask, match)
    return count_on(mask)


def contact_sheet(gif_path, count, out_path):
    selected = [round(i * (count - 1) / 5) for i in range(6)]
    wanted = set(selected + [0, count - 1])
    thumbs = {}
    with Image.open(gif_path) as gif:
        for index, frame in enumerate(ImageSequence.Iterator(gif)):
            if index in wanted:
                thumb = frame.convert('RGB')
                thumb.thumbnail((400, 500), Image.Resampling.LANCZOS)
                thumbs[index] = thumb
    panel_w, panel_h = 420, 530
    sheet = Image.new('RGB', (panel_w * 3, panel_h * 3), '#EEEEEE')
    draw = ImageDraw.Draw(sheet)
    for position, index in enumerate(selected):
        x, y = (position % 3) * panel_w, (position // 3) * panel_h
        draw.text((x + 10, y + 5), f'Frame {index}', fill='black')
        sheet.paste(thumbs[index], (x + 10, y + 25))
    draw.text((10, panel_h * 2 + 5), 'Seam pair: first / last', fill='black')
    sheet.paste(thumbs[0], (10, panel_h * 2 + 25))
    sheet.paste(thumbs[count - 1], (panel_w + 10, panel_h * 2 + 25))
    sheet.save(out_path, format='PNG')


def verify(job):
    gif_path = Path(job['gifPath'])
    frames_dir = Path(job['framesDir'])
    width, height = int(job['expectedWidth']), int(job['expectedHeight'])
    duration, step = int(job['expectedDurationMs']), int(job['stepMs'])
    if width <= 0 or height <= 0 or step <= 0 or duration <= 0 or duration % step:
        raise ValueError('Invalid dimensions or duration/step grid')
    failures, warnings = [], []
    metrics = {'failures': failures, 'warnings': warnings, 'expectedFrames': duration // step}
    paths = sorted((p for p in frames_dir.iterdir() if re.fullmatch(r'frame_\d{4}\.png', p.name)), key=lambda p: int(p.stem[6:]))
    if len(paths) != duration // step or any(p.name != f'frame_{i:04d}.png' for i, p in enumerate(paths)):
        failures.append('source frame sequence must be contiguous and match expectedFrames')
    if not paths:
        raise ValueError('No numbered source PNG frames')
    seam = frames_dir / 'seam.png'
    # Capture's stage result stores seam.png beside frames-40/frames-50/.
    # Prefer the documented in-grid location, and accept capture's sibling file.
    if not seam.is_file() and (frames_dir.parent / 'seam.png').is_file():
        seam = frames_dir.parent / 'seam.png'
        warnings.append('Using capture seam.png from parent work directory')
    metrics['seamPath'] = str(seam.resolve())
    zero = frames_dir / 'frame_0000.png'
    metrics['loopSeamOk'] = seam.is_file() and zero.is_file() and hashlib.sha256(seam.read_bytes()).digest() == hashlib.sha256(zero.read_bytes()).digest()
    if not metrics['loopSeamOk']:
        failures.append('source loop seam hash mismatch or missing seam.png')
    source_size = None

    def source(p):
        nonlocal source_size
        with Image.open(p) as image:
            if source_size is None:
                source_size = image.size
            if image.size != source_size:
                raise ValueError('Source frame dimensions differ')
            return image.convert('RGB').resize((width, height), Image.Resampling.BOX)

    first_source = source(paths[0])
    changed = Image.new('L', (width, height), 0)
    for p in paths[1:]:
        current = source(p)
        changed = ImageChops.lighter(changed, nonzero(channel_max(ImageChops.difference(first_source, current))))
        current.close()
    static_mask = ImageChops.invert(changed).filter(ImageFilter.MinFilter(5))
    metrics['maskPixels'] = count_on(static_mask)
    flicker_union = Image.new('L', (width, height), 0)
    colors = {c.upper(): tuple(int(c[i:i+2], 16) for i in (1, 3, 5)) for c in job.get('reservedColors', [])}
    hits = {c: 0 for c in colors}
    delays, max_diff = [], 0
    with Image.open(gif_path) as gif:
        metrics.update(width=gif.width, height=gif.height, loop=gif.info.get('loop'), bytes=gif_path.stat().st_size)
        if gif.format != 'GIF':
            failures.append('input is not GIF')
        if gif.size != (width, height):
            failures.append('GIF dimensions do not match expected dimensions')
        if metrics['loop'] is None:
            failures.append('no NETSCAPE loop block')
        elif metrics['loop'] != 0:
            failures.append('loop must equal 0 (infinite)')
        decoded_count = gif.n_frames
        first_rgb = None
        for frame in ImageSequence.Iterator(gif):
            delays.append(frame.info.get('duration', 0))
            rgb = frame.convert('RGB')
            if first_rgb is None:
                first_rgb = rgb.copy()
            if rgb.size == (width, height):
                diff = ImageChops.multiply(channel_max(ImageChops.difference(rgb, first_rgb)), static_mask)
                max_diff = max(max_diff, diff.getextrema()[1])
                flicker_union = ImageChops.lighter(flicker_union, nonzero(diff))
            for color, value in colors.items():
                hits[color] += exact_count(rgb, value)
            rgb.close()
        if len(delays) != decoded_count:
            failures.append('decoded delays count differs from GIF n_frames')
    failures.extend(delay_failures(delays, duration, step, job.get('strictFrameCount', False)))
    merged = duration // step - len(delays)
    if merged > 0:
        warnings.append(f'{merged} pixel-identical or redundant source frames merged')
    if metrics['bytes'] > int(job['maxBytes']):
        failures.append('GIF exceeds maxBytes')
    flicker = count_on(flicker_union)
    tolerance = 0.001 * metrics['maskPixels'] if job.get('lossy', False) else 0
    if flicker > tolerance:
        failures.append(f'static-region flicker: {flicker} pixels exceeds {tolerance:g}')
    for color, count in hits.items():
        if count == 0:
            (failures if job.get('encoder') == 'pillow' else warnings).append('reserved color absent: ' + color)
    contact_path = Path(job.get('contactSheet', str(gif_path) + '.contact.png')).resolve()
    contact_path.parent.mkdir(parents=True, exist_ok=True)
    contact_sheet(gif_path, len(delays), contact_path)
    metrics.update(frames=len(delays), mergedFrames=merged, delays=dict(Counter(delays)), totalMs=sum(delays),
                   staticRegionMaxDiff=max_diff, flickerPixelCount=flicker, reservedColorHits=hits, contactSheet=str(contact_path))
    return metrics


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding='utf-8-sig'))
    try:
        result = verify(job)
    except Exception as error:
        result = {'failures': [f'{type(error).__name__}: {error}'], 'warnings': []}
    quality_path = Path(job['qualityPath'])
    quality_path.parent.mkdir(parents=True, exist_ok=True)
    quality_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    sys.exit(1 if result['failures'] else 0)
