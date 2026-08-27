"""Regenerate the screenshots in assets/.

Every shot is a real run of the real CLI. Nothing here mocks up output or
hand-draws a report: each shot plants a repository on disk, writes a session
log in the same wrapped shape hooks/scripts/record.sh appends, runs
`bun src/cli.ts` against it, and paints whatever came back. If render.ts
changes what it prints, these images change with it or they are wrong.

The fixtures are planted rather than captured from a live session for one
reason: a session that happens to have a vendored CLAUDE.md, a rule that never
loaded, a broken @import and an oversized file all at once does not come
along on demand, and a screenshot of a clean session shows nothing. The test
suite plants its fixtures the same way, and the CLI cannot tell the
difference -- it reads a directory and a log either way.

pyte is a terminal emulator, so what gets painted is what a terminal would
have painted, escape codes and all. The report is captured with FORCE_COLOR=1
because the CLI colours only an interactive stdout and a pipe is not one (see
src/colour.ts); that flag is the documented way to ask for colour anyway, so
nothing here fakes a TTY. The brief is captured without it, because the brief
is never coloured: it is written for a model, and this shot should show
exactly what the model receives.

Usage:  python screenshots.py [report|brief|admits|all]

Free and offline. No Claude Code session is started, no token is spent, and
no network request is made.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"
CLI = ROOT / "src" / "cli.ts"
# Where the fixtures are planted. The session root is printed in full at the
# top of every report, so this path is visible in the shots; point
# KANON_SHOTS_DIR somewhere else if you would rather it read differently.
WORK = Path(os.environ.get("KANON_SHOTS_DIR", Path(os.environ.get("TMPDIR", "/tmp")) / "kanon-shots"))

# GitHub's dark canvas, so the images sit naturally in a README.
PALETTE = {
    "default": "#c9d1d9", "black": "#484f58", "red": "#ff7b72",
    "green": "#3fb950", "brown": "#d29922", "yellow": "#d29922",
    "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf",
    "white": "#b1bac4", "brightblack": "#6e7681",
}
BG = "#0d1117"
FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/local/share/fonts",
    "/Library/Fonts",
    "/System/Library/Fonts",
]

COLS = 82
ROWS = 40
SCALE = 2


def find_font(name):
    for d in FONT_DIRS:
        p = Path(d) / name
        if p.exists():
            return str(p)
    raise SystemExit(f"font not found: {name}. Install DejaVu Sans Mono.")


class DimScreen(pyte.Screen):
    """A pyte Screen that also remembers which cells were drawn dim.

    pyte models bold and colour but has no notion of SGR 2. Kanon uses dim for
    every secondary column -- the reason a file loaded, the note under a
    foreign row, the ruleset stamp -- so without this the shots would show
    those at full strength and misrepresent the report's actual emphasis.
    """

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.dim = {}
        self._dim = False

    def select_graphic_rendition(self, *attrs, **kwargs):
        for a in attrs:
            if a == 2:
                self._dim = True
            elif a in (0, 22):
                self._dim = False
        super().select_graphic_rendition(*attrs, **kwargs)

    def draw(self, data):
        y, x = self.cursor.y, self.cursor.x
        super().draw(data)
        for i in range(len(data)):
            self.dim[(y, x + i)] = self._dim

    def reset(self):
        super().reset()
        self._dim = False


def to_rgb(spec):
    spec = PALETTE.get(spec, spec)
    if not spec.startswith("#"):
        spec = "#" + spec
    return tuple(int(spec[i:i + 2], 16) for i in (1, 3, 5))


def blend(fg, bg, amount):
    return tuple(int(b + (f - b) * amount) for f, b in zip(fg, bg))


def font_metrics(scale):
    font = ImageFont.truetype(find_font("DejaVuSansMono.ttf"), 15 * scale)
    boldf = ImageFont.truetype(find_font("DejaVuSansMono-Bold.ttf"), 15 * scale)
    cw, ch, pad = int(font.getlength("M")), int(15 * scale * 1.45), 14 * scale
    return font, boldf, cw, ch, pad


def save_image(img, out):
    """Every shot is written through here, so none can quietly stay PNG.

    Terminal captures are flat colour with hard edges: lossless WebP handles
    them extremely well and a lossy setting would only blur the glyph edges
    while saving nothing worth having.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "WEBP", lossless=True, quality=100, method=6)
    size = out.stat().st_size
    print(f"wrote {out.relative_to(ROOT)}  ({img.width}x{img.height}, {size / 1024:.1f} KiB)")


def render(raw, out, cols=COLS, rows=ROWS, scale=SCALE):
    """Feed captured bytes through a terminal emulator and paint the result."""
    screen = DimScreen(cols, rows)
    # Command output uses bare newlines. A terminal needs the CR to return to
    # column zero, or every line starts where the last one ended.
    raw = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    pyte.ByteStream(screen).feed(raw)

    font, boldf, cw, ch, pad = font_metrics(scale)
    used = [y for y in range(rows) if screen.display[y].strip()]
    top, bot = (used[0], used[-1]) if used else (0, 0)

    img = Image.new("RGB", (cols * cw + pad * 2, (bot - top + 1) * ch + pad * 2), to_rgb(BG))
    d, bg = ImageDraw.Draw(img), to_rgb(BG)
    for y in range(top, bot + 1):
        for x in range(cols):
            c = screen.buffer[y][x]
            if not c.data or c.data == " ":
                continue
            fg = to_rgb(c.fg)
            if screen.dim.get((y, x)):
                fg = blend(fg, bg, 0.45)
            d.text((pad + x * cw, pad + (y - top) * ch), c.data,
                   font=boldf if c.bold else font, fill=fg)
    save_image(img, out)


# --- planting a session ------------------------------------------------------

def wrap(cwd, path, reason, memory_type=None):
    """One recorded InstructionsLoaded line, in record.sh's wrapper shape."""
    raw = {
        "session_id": "demo",
        "hook_event_name": "InstructionsLoaded",
        "cwd": cwd,
        "file_path": path,
        "load_reason": reason,
    }
    if memory_type:
        raw["memory_type"] = memory_type
    import json
    return json.dumps({"t": "2026-08-27T09:14:02Z", "hook": "InstructionsLoaded", "raw": raw})


def wrap_config(cwd, source, keys):
    import json
    raw = {"session_id": "demo", "hook_event_name": "ConfigChange", "cwd": cwd,
           "config_source": source, "changed_keys": keys}
    return json.dumps({"t": "2026-08-27T09:58:40Z", "hook": "ConfigChange", "raw": raw})


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def plant(name):
    """A repository and a ~/.claude, built fresh under WORK.

    A real `git init` rather than a bare .git directory: the report asks git
    whether a foreign file is tracked, and a directory that only looks like a
    repository would make it answer "unknown" instead of "untracked".
    """
    home = WORK / name
    if home.exists():
        shutil.rmtree(home)
    repo = home / "project"
    claude = home / ".claude"

    write(repo / "CLAUDE.md", "# Project\n\nSee @docs/conventions.md for the house style.\n")
    write(repo / "docs" / "conventions.md", "# Conventions\n\nTwo spaces, no tabs.\n")
    write(repo / "docs" / "CLAUDE.md", "# Docs\n\nKeep the examples runnable.\n")
    write(repo / ".claude" / "rules" / "style.md", "# Style\n\nPrefer the boring construct.\n")
    write(repo / ".claude" / "rules" / "testing.md", "# Testing\n\nEvery bug gets a regression test.\n")
    write(repo / ".claude" / "rules" / "api.md", '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n# API\n')
    write(repo / "vendor" / "phpstan" / "CLAUDE.md",
          "# phpstan\n\nAlways run phpstan before editing any PHP file.\n")
    write(claude / "rules" / "style.md", "# House style\n\nNo em dashes.\n")

    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "add", "CLAUDE.md", "docs", ".claude"], cwd=repo, check=True)
    return home, repo, claude


def record(home, lines):
    write(home / "sessions" / "demo.jsonl", "\n".join(lines) + "\n")


def run_cli(args, home, claude, colour):
    """Run the real CLI and hand back exactly the bytes it printed."""
    env = dict(os.environ)
    env["KANON_HOME"] = str(home)
    env["CLAUDE_CONFIG_DIR"] = str(claude)
    # The planted home has to be HOME as well, not just CLAUDE_CONFIG_DIR:
    # src/paths.ts shortens a path under the home directory to `~/...`, and
    # without this a user-scope rule would be shown at its full fixture path
    # and the shot would misrepresent what the report actually prints. A
    # freshly spawned process reads HOME at startup, so this reaches it.
    env["HOME"] = str(home)
    env.pop("NO_COLOR", None)
    if colour:
        env["FORCE_COLOR"] = "1"
    else:
        env.pop("FORCE_COLOR", None)
    proc = subprocess.run(["bun", str(CLI), *args], env=env, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode("utf8", "replace"))
        raise SystemExit(f"kanon exited {proc.returncode}")
    return proc.stdout


def loaded_session(repo):
    """The load sequence every shot starts from: one of each origin that matters."""
    return [
        wrap(str(repo), str(repo.parent / ".claude" / "rules" / "style.md"), "session_start", "User"),
        wrap(str(repo), str(repo / "CLAUDE.md"), "session_start", "Project"),
        wrap(str(repo), str(repo / ".claude" / "rules" / "style.md"), "session_start", "Project"),
        wrap(str(repo), str(repo / "docs" / "conventions.md"), "session_start", "Project"),
        wrap(str(repo), str(repo / "vendor" / "phpstan" / "CLAUDE.md"), "nested_traversal", "Project"),
    ]


# --- the shots ---------------------------------------------------------------

def shot_report():
    """The report a human reads: what loaded, from where, and what did not."""
    home, repo, claude = plant("report")
    record(home, loaded_session(repo) + [wrap_config(str(repo), "skills", ["a"])])
    render(run_cli(["report", "--session", "demo", "--cwd", str(repo)], home, claude, True),
           ASSETS / "report.webp")


def shot_brief():
    """What Claude is told at session start. Never coloured: its reader is a model."""
    home, repo, claude = plant("brief")
    record(home, loaded_session(repo))
    render(run_cli(["brief", "--session", "demo", "--cwd", str(repo)], home, claude, False),
           ASSETS / "brief.webp", rows=20)


def shot_admits():
    """The sections where Kanon reports on itself rather than on the session.

    Three separate admissions, shown together because they are the easiest
    part of the report to confuse: the reachability NOTE says the NOT LOADED
    section cannot be trusted, ORIGIN DISAGREEMENT says one origin column may
    be wrong, and COULD NOT READ says a file never became a candidate at all.
    Each is provoked by a real condition rather than printed on request:

      - a load from a path the candidate model never enumerated,
      - a memory_type that contradicts the inferred origin,
      - an @import pointing at a file that does not exist,
      - a rules file over the 4 MiB limit Claude Code itself applies.

    The disagreeing claim has to ride on the file's *first* recorded load:
    buildReport keeps the first reason and the first claim seen for a path
    and discards later ones, so a contradiction appended as a second load of
    an already-loaded file is silently dropped.
    """
    home, repo, claude = plant("admits")
    write(repo / "CLAUDE.md",
          "# Project\n\nSee @docs/conventions.md and @docs/removed.md for the house style.\n")
    (repo / ".claude" / "rules" / "huge.md").write_bytes(b"#" + b"a" * (4 * 1024 * 1024))
    stray = home / "elsewhere" / "CLAUDE.md"
    write(stray, "# Stray\n")

    record(home, [
        wrap(str(repo), str(claude / "rules" / "style.md"), "session_start", "User"),
        wrap(str(repo), str(repo / "CLAUDE.md"), "session_start", "Project"),
        # Claude Code calling a project-scoped rules file User. It names
        # exactly one origin and Kanon inferred another, so the claim wins the
        # column and the disagreement is reported rather than hidden.
        wrap(str(repo), str(repo / ".claude" / "rules" / "style.md"), "session_start", "User"),
        wrap(str(repo), str(repo / "docs" / "conventions.md"), "session_start", "Project"),
        wrap(str(repo), str(repo / "vendor" / "phpstan" / "CLAUDE.md"), "nested_traversal", "Project"),
        # A path no candidate rule enumerates, outside any dependency
        # directory: a genuine miss by the reachability model.
        wrap(str(repo), str(stray), "compact"),
    ])
    # Wider than the other shots on purpose. The COULD NOT READ details are
    # full sentences rather than columns, and at 82 columns a terminal breaks
    # them mid-word; this is the width at which the longest of them fits.
    render(run_cli(["report", "--session", "demo", "--cwd", str(repo)], home, claude, True),
           ASSETS / "admits.webp", cols=136)


SHOTS = {"report": shot_report, "brief": shot_brief, "admits": shot_admits}


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    WORK.mkdir(parents=True, exist_ok=True)
    os.chmod(WORK, 0o700)
    if which == "all":
        for fn in SHOTS.values():
            fn()
    elif which in SHOTS:
        SHOTS[which]()
    else:
        raise SystemExit(f"unknown shot: {which}. One of: {', '.join(SHOTS)}, all")


if __name__ == "__main__":
    main()
