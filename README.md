# Zip Ties for ComfyUI

A frontend extension that bundles wires into a ribbon with small zip ties. The idea comes from a [prototype by @cmzw_](https://x.com/cmzw_/status/2114315567977107653).

![Demo: two Z-drag cuts bundle seven wires, then the ties are dragged around](preview.gif)

The full recording with the cut and removal gestures is [zip-ties-demo.mp4](zip-ties-demo.mp4).

## Use

| Action | Gesture |
|---|---|
| Tie wires together | Hold `Z` and drag a line across the wires |
| Move a tie | Drag the tie |
| Remove a tie | Hold `Z` and drag a line across the tie, or double-click it |

The wires keep their colours and run side by side between ties. Hovering or dragging a tie highlights every wire in it. A wire can pass through several ties. When a wire is deleted or reconnected, it leaves its ties, and a tie with no wires left disappears.

Ties are stored in the workflow's `extra.zipTies`, so they save, load and undo with the rest of the graph. Workflows opened without the extension still load; the wires draw normally.

## Install

Clone into `ComfyUI/custom_nodes` and restart ComfyUI:

```sh
cd ComfyUI/custom_nodes
git clone https://github.com/safzanpirani/comfyui-zip-ties
```

The extension adds no nodes and has no Python dependencies.

## Limits

- Wires that pass through native reroutes cannot be tied.
- The ribbon shape is tuned for spline links. Straight and linear link modes still route through the ties, but the cut test treats each segment as a straight line.
- Tested on ComfyUI 0.42.0 with frontend 1.57.1, in both the classic canvas and Vue nodes mode.

## License

MIT
