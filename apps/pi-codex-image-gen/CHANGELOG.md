# Changelog

## [Unreleased]

## [0.3.4] - 2026-11-28

### New

- `image_gen` can create simple animated GIFs with 2–16 frames, following Codex. Turn it on with `"gif": true` in the image settings file; it is off by default. The GIF is saved as a `.gif` file, and the model and terminal show its first frame.
- A GIF request can set `frame_count` and `frame_duration_ms` (20–2000 ms per frame). With `{}`, the backend uses 9 frames at 200 ms per frame.
- After you set `"gif": true`, the `gif` argument becomes available at the next session start (a new session, `/reload`, or restarting Pi). If you remove the key or set it to `false`, the next GIF request fails with `GIF output is unavailable in this session.` Any value other than `true` or `false` returns a settings error.

### Improved

- In the terminal summary, a GIF request shows `GIF` on the request line, and its result heading reads `Generated GIF` or `Edited GIF`.

## [0.3.3] - 2026-11-02

### Improved

- `/codex-imagen`, the `image_gen` call and result rows, and their error messages are now in English.

## [0.3.2] - 2026-11-02

### New

- Pi 1.5.0 and later show what changed in this package after you update it.

### Improved

- The package now contains only the files Pi loads. Type declarations and source maps are no longer included.

## [0.3.1] - 2026-10-21

### Improved

- The README explains how a successful result appears in terminals with and without inline images, and that local reference paths may start with `~/`.

## [0.3.0] - 2026-10-21

### New

- `image_gen` calls now show a short summary with the operation, image size, and saved path instead of the model-facing path hint. Click the path to open the image in your default app.
- Click a generated image to zoom it to fit the terminal height, and click it again to restore its size. Each image zooms separately in Pi's default fullscreen mode.

### Improved

- The bundled `imagegen` skill now tells the model that independent images can be generated in parallel by requesting them in one response.
- Large backend responses are bounded, and oversized errors no longer flood the conversation.
- Local reference loading respects cancellation and rejects directories, pipes, and device paths.
- Empty or invalid image data now returns an error; large valid images no longer silently fail to save. Saving a local copy remains best-effort.
- Documented where generated images remain and how to clean them up manually.

## [0.2.4] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
