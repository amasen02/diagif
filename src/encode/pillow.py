"""Two-pass encoder using a single reserved-color palette and no dithering."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageSequence, features


def hex_to_rgb(value):
    if len(value) != 7 or value[0] != '#':
        raise ValueError('Expected #RRGGBB reserved color')
    return tuple(int(value[i:i+2], 16) for i in (1, 3, 5))


def static_mask(paths, size):
    def source(p):
        with Image.open(p) as image:
            return image.convert('RGB').resize(size, Image.Resampling.BOX)
    first = source(paths[0])
    changed = Image.new('L', size, 0)
    for p in paths[1:]:
        current = source(p)
        r, g, b = ImageChops.difference(first, current).split()
        maximum = ImageChops.lighter(ImageChops.lighter(r, g), b)
        changed = ImageChops.lighter(changed, maximum.point([0] + [255] * 255))
        current.close()
    first.close()
    return ImageChops.invert(changed).filter(ImageFilter.MinFilter(5))


def encode(job):
    paths = job['framePaths']
    width = int(job['width'])
    reserved = list(dict.fromkeys(hex_to_rgb(c) for c in job.get('reservedColors', [])))
    colors = int(job.get('paletteColors', 256))
    if not paths or width < 1 or not 2 <= colors <= 256 or len(reserved) >= colors:
        raise ValueError('Invalid frames, width, or palette capacity')
    delay = int(job['delayMs'])
    if delay <= 0 or delay % 10:
        raise ValueError('GIF delay must be a positive multiple of 10 ms')
    source_size = None

    def open_scaled(p):
        nonlocal source_size
        with Image.open(p) as im:
            if source_size is None:
                source_size = im.size
            if im.size != source_size:
                raise ValueError('Source frame dimensions differ: ' + str(p))
            rgb = im.convert('RGB')
            scaled = rgb.resize((width, round(rgb.height * width / rgb.width)), Image.Resampling.LANCZOS)
            rgb.close()
            return scaled

    n = len(paths)
    k = max(2, min(int(job.get('sampleCount', 8)), n))
    indices = sorted(set(round(i * (n - 1) / (k - 1)) for i in range(k)))
    first = open_scaled(paths[0])
    sheet = Image.new('RGB', (width, first.height * len(indices)))
    first.close()
    for position, index in enumerate(indices):
        sample = open_scaled(paths[index])
        sheet.paste(sample, (0, position * sample.height))
        sample.close()
    method_name = job.get('paletteMethod', 'mediancut')
    if method_name not in ('mediancut', 'libimagequant'):
        raise ValueError('Unknown paletteMethod')
    if method_name == 'libimagequant' and not features.check_feature('libimagequant'):
        method_name = 'mediancut'
    method = Image.Quantize.LIBIMAGEQUANT if method_name == 'libimagequant' else Image.Quantize.MEDIANCUT
    count = colors - len(reserved)
    quantized = sheet.quantize(colors=count, method=method, dither=Image.Dither.NONE)
    base_palette = bytes(quantized.getpalette()[:3 * count])
    count = len(base_palette) // 3
    palette = base_palette + b''.join(bytes(c) for c in reserved)
    # Fill remaining table slots with an existing color, never an accidental new black.
    palette += palette[:3] * (256 - len(palette) // 3)
    master = Image.new('P', (1, 1))
    master.putpalette(palette)
    sheet.close()
    quantized.close()
    # A Lanczos halo reaches beyond the contract's 2px BOX-mask erosion.
    # Lock these source-static palette indices to frame zero after quantizing.
    stable_mask = static_mask(paths, (width, round(source_size[1] * width / source_size[0])))
    indexed = []
    try:
        for p in paths:
            frame = open_scaled(p)
            quantized_frame = frame.quantize(palette=master, dither=Image.Dither.NONE)
            # Pillow's RGB->P nearest-color cache uses reduced precision. Reserve
            # entries alone do not guarantee exact source colors select them.
            for offset, color in enumerate(reserved):
                mask = None
                for channel, value in zip(frame.split(), color):
                    lookup = [0] * 256
                    lookup[value] = 255
                    match = channel.point(lookup)
                    mask = match if mask is None else ImageChops.darker(mask, match)
                quantized_frame.paste(count + offset, (0, 0), mask)
            if indexed:
                quantized_frame.paste(indexed[0], (0, 0), stable_mask)
            indexed.append(quantized_frame)
            frame.close()
        Path(job['outPath']).parent.mkdir(parents=True, exist_ok=True)
        durations = job.get('delays', delay)
        if isinstance(durations, list) and (len(durations) != len(indexed) or any(d <= 0 or d % 10 for d in durations)):
            raise ValueError('Invalid per-frame GIF durations')
        indexed[0].save(job['outPath'], save_all=True, append_images=indexed[1:], duration=durations,
                        loop=0, disposal=1, optimize=True, palette=palette)
    finally:
        for frame in indexed:
            frame.close()
        master.close()
    return {'paletteMethod': method_name, 'sampleIndices': indices, 'sourceFrames': n, 'reservedColors': len(reserved)}


def stabilize(job):
    """Repair native palette shimmer; retain native decoded movement and delays.

    Only runs a shared-palette rewrite when static source pixels actually differ.
    RGB GIF frames are streamed to disk, never accumulated in memory.
    """
    import tempfile
    source_paths = job['framePaths']
    gif_path = Path(job['gifPath'])
    with Image.open(gif_path) as gif:
        size = gif.size
    def source(p):
        with Image.open(p) as frame:
            return frame.convert('RGB').resize(size, Image.Resampling.BOX)
    first_source = source(source_paths[0])
    changed = Image.new('L', size, 0)
    for p in source_paths[1:]:
        current = source(p)
        difference = ImageChops.difference(first_source, current)
        r, g, b = difference.split()
        maximum = ImageChops.lighter(ImageChops.lighter(r, g), b)
        changed = ImageChops.lighter(changed, maximum.point([0] + [255] * 255))
        current.close()
    mask = ImageChops.invert(changed).filter(ImageFilter.MinFilter(5))
    first_source.close()
    changed.close()
    flicker = Image.new('L', size, 0)
    with Image.open(gif_path) as gif:
        baseline = gif.convert('RGB')
        for frame in ImageSequence.Iterator(gif):
            difference = ImageChops.difference(baseline, frame.convert('RGB'))
            r, g, b = difference.split()
            maximum = ImageChops.multiply(ImageChops.lighter(ImageChops.lighter(r, g), b), mask)
            flicker = ImageChops.lighter(flicker, maximum.point([0] + [255] * 255))
    pixels = sum(flicker.histogram()[1:])
    if not pixels and not job.get('force'):
        return {'applied': False, 'nativeFlickerPixels': 0}
    temp_dir = Path(tempfile.mkdtemp(prefix='gifski-stable-', dir=gif_path.parent))
    paths, delays = [], []
    with Image.open(gif_path) as gif:
        for index, frame in enumerate(ImageSequence.Iterator(gif)):
            rgb = frame.convert('RGB')
            rgb.paste(baseline, (0, 0), mask)
            target = temp_dir / f'frame_{index:04d}.png'
            rgb.save(target)
            rgb.close()
            paths.append(str(target))
            delays.append(frame.info.get('duration', 0))
    baseline.close()
    stabilized = temp_dir / 'stable.gif'
    result = encode({'framePaths': paths, 'width': size[0], 'delayMs': job['stepMs'], 'delays': delays,
                     'reservedColors': job.get('reservedColors', []), 'outPath': str(stabilized),
                     'paletteColors': 256, 'sampleCount': 8, 'paletteMethod': 'mediancut'})
    # Retain the native bytes beside the rewritten output for audit and comparison.
    native_path = str(gif_path) + '.native.gif'
    import shutil
    shutil.copyfile(gif_path, native_path)
    shutil.copyfile(stabilized, gif_path)
    return {'applied': True, 'nativeFlickerPixels': pixels, 'method': 'Pillow shared palette with static source mask',
            'nativePath': native_path, 'intermediateDir': str(temp_dir), 'paletteMethod': result['paletteMethod']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    args = parser.parse_args()
    job = json.loads(args.job.read_text(encoding='utf-8-sig'))
    print(json.dumps(stabilize(job) if job.get('mode') == 'stabilize' else encode(job)))
