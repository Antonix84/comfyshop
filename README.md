# ComfyShop

Photoshop UXP panel for running ComfyUI workflows and inserting the result as a new layer in the current document.

## Features

- Connect/disconnect to a local or remote ComfyUI server.
- Workflow list is read from the ComfyUI server (`/userdata?dir=workflows`, i.e. ComfyUI's `user/default/workflows`).
- Nodes whose titles start with `#` become editable parameters. SD-PPP style `sdppp_widgetable_title` markers work too.
- Rename a widget (input) inside a `#` node so its label starts with `#` (e.g. `#megapixels`) to show only the parameters you actually want to edit. As soon as a workflow contains at least one marked widget, every `#` node shows only its marked widgets.
- Each `#` image input gets its own `Send all` / `Send layer` block with a preview. The first image input always has one; additional inputs appear when the `LoadImage` node (or its image widget) is marked with `#`.
- `Send all` captures the flattened active document, `Send layer` captures the active layer. The sent image appears in that block's preview immediately and is used by the next generation.
- `Reload` re-reads the workflow and resets all parameters, seeds, sent images, and the selected output to the values stored in the workflow JSON.
- UI-format workflows, API-format prompts, and workflows with ComfyUI subgraphs (both legacy and new definition formats) are accepted.
- `x1`, `x2`, `x5` run the workflow one or more times (two buttons per row). Every returned image is inserted as a separate layer.
- Connects automatically on startup and reconnects every 7 s after the connection is lost (a single lightweight health check every 10 s).
- `Stop` interrupts the current generation.
- Result layers are named `<workflow> <time> <duration>`.
- Batch runs (`x2`, `x5`) give every seed in the graph a new value, including samplers that are not `#` nodes, so each run is a different picture. A seed marked `fixed` in ComfyUI, or one whose `each` checkbox was cleared, keeps its value.
- Layer exports keep transparency; results are scaled and placed back into the exported area.
- Only the part of the graph that feeds the selected output is sent to ComfyUI, so unrelated nodes with missing custom packs do not block a run.

## Requirements

- Adobe Photoshop 2025 or newer with UXP support.
- ComfyUI reachable over HTTP (default `http://127.0.0.1:7861`).
- UXP Developer Mode enabled for loading an unsigned local plugin.

## Install

1. Download or clone this repository.
2. Close Photoshop.
3. Run `install.bat` (or `powershell -ExecutionPolicy Bypass -File tools\install.ps1`).
4. Restart Photoshop.
5. Open `Plugins > ComfyShop` (or the Plugins panel).

If UXP Developer Mode is not enabled yet, enable it once with the UXP Developer Tool or run:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -EnableDeveloperMode
```

The last command needs administrator rights.

Uninstall with `uninstall.bat`.

## Usage

1. Open the ComfyShop panel. It connects to the last server automatically.
2. If needed, press `Settings`, change the ComfyUI server address, and press `Connect`.
3. Choose a workflow. Its `#`-prefixed nodes appear as parameters; inside them only widgets marked with `#` are shown (if any are marked).
4. Each image input shows a `Send all` / `Send layer` pair with a preview. Switch to the needed Photoshop document or layer and press the button for that input; the captured image appears in the preview under the buttons.
5. Workflows with several `#` image inputs show another identical block right below the first one (`Photo 1`, `Photo 2`, ...).
6. Press `x1`, `x2`, or `x5`. Results are inserted into the original document as new layers.

The workflow list comes from the ComfyUI server, so the panel works with a remote server as well. Put workflow JSON files into ComfyUI's `user/default/workflows` folder on the server.

## Development

The plugin source is in `plugin/`. The install script copies it to:

```
%APPDATA%\Adobe\UXP\Plugins\External\com.comfyshop.panel_<version>
```

and registers it in:

```
%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json
```

To validate workflow conversion and ComfyUI execution without Photoshop:

```powershell
node tools\test-pipeline.js
node tools\test-pipeline.js --run
```

Set `COMFY_HOST`, `COMFY_WORKFLOW`, and `COMFY_IMAGE` environment variables to test another server/workflow/image.

## Notes and limitations

- Workflows with ComfyUI subgraphs are flattened automatically (old and new `definitions.subgraphs` formats). If a workflow cannot be inlined, export it with `Export (API)` and use that JSON instead.
- Sent images are uploaded to ComfyUI's `input` folder and used by the next generation. They are kept for the current Photoshop session only, so after a restart press `Send` again.
- `Reload` clears the sent images and restores the workflow's stored images.
- Missing custom nodes are reported only when the selected output actually needs them; unused unknown nodes are skipped.
- Both legacy `widgets_values` and newer `widgets_values_named` are supported, including the newer `COMBO` input format used by nodes such as `ImageScaleToTotalPixels`.
- The panel is inspired by the concept of SD-PPP but is an independent implementation.

## License

MIT. See `LICENSE`.
