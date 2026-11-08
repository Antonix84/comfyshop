# ComfyShop

Photoshop UXP panel for running ComfyUI workflows and inserting the result as a new layer in the current document.

## Features

- Connect/disconnect to a local or remote ComfyUI server.
- Workflow list is read from the ComfyUI server (`/userdata?dir=workflows`, i.e. ComfyUI's `user/default/workflows`).
- Nodes whose titles start with `#` become editable parameters.
- `x1`, `x2`, `x5`, `x10` run the workflow one or more times. Every result is inserted as a separate layer.
- `Stop` interrupts the current generation.
- Result layers are named `<workflow> <time> <duration>`.
- Batch runs randomize seed values (unless the per-seed `each` checkbox is disabled).

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

1. Open the ComfyShop panel.
2. Press `Settings`, enter the ComfyUI server address, press `Connect`.
3. Choose a workflow. Its `#`-prefixed nodes appear as parameters.
4. Choose what to send to ComfyUI: flattened document, active layer, or selection.
5. Press `x1`, `x2`, `x5`, or `x10`. Results are inserted into the original document as new layers.

The workflow list comes from the ComfyUI server, so the panel works with a remote server as well. Put workflow JSON files into ComfyUI's `user/default/workflows` folder on the server.

## Development

The plugin source is in `plugin/`. The install script copies it to:

```
%APPDATA%\Adobe\UXP\Plugins\External\com.comfyshop.panel_1.0.0
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

- Workflows using ComfyUI subgraphs are not supported yet.
- Missing custom nodes are reported as workflow errors.
- Both legacy `widgets_values` and newer `widgets_values_named` are supported, including the newer `COMBO` input format used by nodes such as `ImageScaleToTotalPixels`.
- The panel is inspired by the concept of SD-PPP but is an independent implementation.

## License

MIT. See `LICENSE`.
