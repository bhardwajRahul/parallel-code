# Showcase video editor

`edit.mjs` turns screen recordings into a silent 1920 × 1080, 30 fps showcase MP4 with dissolves, eased zooms and fading captions. It also writes a `.jpg` poster beside the video. The whole edit is described in one JSON timeline, so a new cut means editing data, not code.

Requirements: Node.js and `ffmpeg` on `PATH`. Captions use Noto Sans by default (`fonts-noto-core` on Debian/Ubuntu); set `fonts` in the timeline to use other TTF files.

```sh
cp scripts/showcase/example-timeline.json ~/showcase-footage/timeline.json
# edit the clip list and captions, then:
node scripts/showcase/edit.mjs ~/showcase-footage/timeline.json
```

Keep footage, renders and output outside the repository. Relative paths in the timeline resolve from the timeline file. Rendered clips are cached in `work` and reused while a clip's settings and source file are unchanged. Caption and transition edits therefore rerun only the final encode (about 1–2 minutes for a 50-second video); changing a clip's `start`, `duration` or `camera` rerenders that clip. After changing the render code itself, delete `work`, because the cache does not track the script.

## Timeline format

`example-timeline.json` is the edit of the 47-second v10 showcase.

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `footage`  | Folder with the raw recordings. Default: the timeline's folder.      |
| `work`     | Cache for rendered clips and filter files. Default: `work`.          |
| `output`   | Final MP4. The poster uses the same name with `.jpg`.                |
| `posterAt` | Poster frame time in seconds. Default: `1`.                          |
| `fonts`    | Optional `{ "regular": "...ttf", "bold": "...ttf" }`.                |
| `clips`    | Shots in order. Each needs `file`, `start` and `duration` (seconds). |
| `cues`     | Captions: `title`, optional `sub`, and `at`/`until` anchors.         |

Clips play at their recorded speed and dissolve into each other over 0.4 s. Set `"transitionAfter"` to change the dissolve after a clip; `0` makes a hard join, which suits two adjoining pieces of the same recording. Each clip must be longer than its incoming and outgoing dissolves combined.

Recordings must be 16:9; they are scaled to 1920 × 1080. Recording above 1080p, for example 2400 × 1350, keeps zooms up to 1.25× sharp.

### Camera

A clip's optional `camera` eases in and out of zooms at chosen moments:

```json
{
  "focusX": 0.89,
  "focusY": 0.28,
  "moves": [
    { "at": 1.3, "seconds": 0.8, "zoom": 1.35 },
    { "at": 3.8, "seconds": 0.8, "zoom": 1 }
  ]
}
```

- `focusX`/`focusY` (0–1) pick the point to zoom toward: `0, 0` is the top-left, `1, 1` the bottom-right.
- `at` is seconds from the clip start. Time each move to the UI event it points at, such as a click or a dialog opening, not to the clip length.
- Zoom values are at least 1. A move may set a new `focusX`/`focusY` only when it starts from zoom 1, where the switch is invisible; the editor rejects other focus changes.
- `startZoom` begins the clip already zoomed, which continues a zoom across a dissolve.
- `clockOffset` continues another clip's camera clock. Use it with `transitionAfter: 0` when one shot is split into two clips.

### Captions

Anchors are `[clipIndex, offsetSeconds]`, relative to that clip's start in the final video. Offsets may be negative, so `[4, -0.4]` means 0.4 s before clip 4 starts; `clips.length` means the end of the video. A cue must end after it starts. Anchors therefore stay correct when clips are trimmed. Captions fade over 0.3 s over a soft dark gradient in the lower left.

## Recording guide

- **One theme for every take.** Mixing themes is visible in cuts, and it forced the v8 cut to drop an entire scene.
- **Store raw recordings permanently**, not in `/tmp`. Without them, clips cannot be re-trimmed or re-framed.
- Record at 2400 × 1350 or more, at 30 fps, with a separate demo profile and repository. Use one window size throughout.
- Enlarge application text until tour cards and task titles are readable at 1080p. Hide unrelated projects, notifications, tokens and private paths.
- Keep 2 seconds of still footage before and after each action, so dissolves and zooms have room.
- Record real task creation and agent output. Cut waits instead of speeding footage up; label any sped-up footage.
- Check the tour and dialog layouts at 1080p before recording. Plan zooms for small UI such as tour cards and menus.

### How the v10 footage was captured

The v10 takes were recorded by an agent session that drove the app automatically. Its helper scripts lived in `/tmp` and were lost, so this is what is known, not a tested recipe:

- A small launcher started the compiled app (`dist-electron/main.js`) from an Electron entry script. Before import, it set `app.setPath('userData', …)` to a throwaway profile and `app.commandLine.appendSwitch('remote-debugging-port', '9334')`. It also set `VITE_DEV_SERVER_URL` to a separately running Vite dev server, and fixed each window at 1920 × 1080 with `setBounds`.
- A separate control script then drove the UI through that Chrome DevTools Protocol port. Its code was not kept.
- The screen recording method is unknown. The takes are 2400 × 1350 at 30 fps, which suggests a 1.25× device scale on the 1920 × 1080 window. The visible pointer was added in editing and is not the real cursor.
- The demo used a separate throwaway Git repository with fictional content.

To reproduce this, write the launcher and control script again, and keep them beside the raw takes, outside `/tmp`.

## Checking the result

```sh
ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate,nb_frames -of compact showcase.mp4
ffmpeg -v error -i showcase.mp4 -f null -   # full decode; prints nothing when clean
```

Also look at extracted frames around every cut, zoom and caption, then watch the video once at normal speed in a desktop player.
