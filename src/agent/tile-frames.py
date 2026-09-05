"""Create bounded critic images from frames, never from a contact sheet."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


PANEL_WIDTH = 768
GUTTER = 16
HEADER_HEIGHT = 28
HEADER_BACKGROUND = "#eef1f3"
HEADER_FOREGROUND = "#334155"
GUTTER_COLOR = "#d7dde2"


def tile_frames(frames, seam, output):
    if not frames:
        raise ValueError("At least one source frame is required")
    output.mkdir(parents=True, exist_ok=True)
    indices = sorted(set(round(i * (len(frames) - 1) / 3) for i in range(4)))
    selected = [frames[i] for i in indices]
    pairs = [("frames-01", [(source, f"FRAME {index}") for source, index in zip(selected[:2], indices[:2])])]
    if len(selected) > 2:
        pairs.append(("frames-23", [(source, f"FRAME {index}") for source, index in zip(selected[2:4], indices[2:4])]))
    pairs.append(("seam", [(seam or frames[-1], "SEAM: LAST"), (frames[0], "SEAM: FIRST")]))
    paths = []
    for name, pair in pairs:
        images = []
        labels = []
        for source, label in pair:
            with Image.open(source) as image:
                image.load()
                native_height = round(image.height * 800 / image.width)
                if native_height not in (1000, 1100):
                    raise ValueError("Expected an 800x1000 or 800x1100 aspect ratio")
                height = round(image.height * PANEL_WIDTH / image.width)
                images.append(image.convert("RGB").resize((PANEL_WIDTH, height), Image.Resampling.LANCZOS))
                labels.append(label)
        sheet = Image.new("RGB", (PANEL_WIDTH * len(images) + GUTTER * (len(images) - 1), HEADER_HEIGHT + max(im.height for im in images)), HEADER_BACKGROUND)
        draw = ImageDraw.Draw(sheet)
        font = ImageFont.load_default()
        for i, image in enumerate(images):
            x = i * (PANEL_WIDTH + GUTTER)
            draw.text((x + 8, 8), labels[i], fill=HEADER_FOREGROUND, font=font)
            sheet.paste(image, (x, HEADER_HEIGHT))
            if i:
                draw.rectangle((x - GUTTER, 0, x - 1, sheet.height), fill=GUTTER_COLOR)
        destination = output / (name + ".png")
        sheet.save(destination, optimize=True)
        if destination.stat().st_size > 3_000_000:
            sheet.quantize(colors=256).save(destination, optimize=True)
        if destination.stat().st_size > 3_000_000:
            raise ValueError("Critic PNG exceeds 3 MB")
        paths.append(str(destination.resolve()))
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seam", type=Path)
    args = parser.parse_args()
    frames = sorted(args.frames_dir.glob("frame_*.png"))
    print(json.dumps({"images": tile_frames(frames, args.seam, args.out)}))


if __name__ == "__main__":
    main()
