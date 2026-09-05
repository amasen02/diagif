"""Create encoder fixtures: python make-frames.py DIRECTORY COUNT [--step 40]."""
import argparse
from pathlib import Path
import shutil
from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("count", type=int)
    parser.add_argument("--step", type=int, choices=(40, 50), default=40)
    args = parser.parse_args()
    if not 1 <= args.count <= 250:
        parser.error("count must be between 1 and 250")
    args.directory.mkdir(parents=True, exist_ok=True)
    # Only remove old numbered fixtures; unrelated files are preserved.
    for old in args.directory.glob("frame_[0-9][0-9][0-9][0-9].png"):
        old.unlink()
    font_path = Path(__file__).resolve().parents[2] / "fonts/inter/Inter[opsz,wght].ttf"
    font = ImageFont.truetype(str(font_path), 48)
    for index in range(args.count):
        image = Image.new("RGB", (1600, 2000), "#042F2E")
        draw = ImageDraw.Draw(image)
        draw.text((100, 100), "STATIC TEXT: technical GIF encoder fixture", fill="#FFFFFF", font=font)
        draw.rectangle((100, 250, 1500, 300), fill="#22D3EE")
        draw.rectangle((100, 350, 1500, 400), fill="#34D399")
        x = 100 + round(1200 * index / args.count)
        draw.rectangle((x, 900, x + 180, 1080), fill="#FB923C")
        image.save(args.directory / f"frame_{index:04d}.png")
    shutil.copyfile(args.directory / "frame_0000.png", args.directory / "seam.png")
    print(f"Created {args.count} frames, 1600x2000, duration {args.count * args.step} ms; seam equals frame 0")


if __name__ == "__main__":
    main()
