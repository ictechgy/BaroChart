# Optional fixed overlay slots

`attachChartOverlays(emptyContainer, chart, {label})`, exported from canvas/root,
creates four fixed DOM slots: `topLeft`, `topRight`, `bottomLeft`, `bottomRight`.
The host supplies and positions a dedicated empty layer over its chart. The helper
owns only its grid wrapper, not the surrounding layout or the content's behavior.

```js
import {attachChartOverlays} from 'barochart/canvas';
// Host CSS: chartHost { position: relative }
// overlayHost { position: absolute; inset: 0; pointer-events: none; z-index: 1 }
const overlays = attachChartOverlays(overlayHost, chart, {label: 'Study controls'});
const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Host action';
overlays.slots.topRight.append(button);
// Host installs and later removes its own handlers/resources.
// overlays.destroy(); // idempotent, also called by chart.destroy()
```

The full-size grid does not receive pointer input; occupied slots do. Each slot
stays in its half-width/half-height cell, with overflow scrolling instead of
unbounded overlap. Host content can still obscure chart data. Hosts must test
contrast, sizing, focus, scroll and mobile hit targets for their own controls.
Native keyboard/focus behavior is not replaced. No HTML strings, render callbacks,
price/time coordinates, script evaluation, arbitrary docking or model mutations
are accepted. Unknown options and invalid labels reject before mounting.

One overlay binding is allowed per chart and per container. Mount failure retires
the binding. Slots survive Canvas/GPU fallback because there are no canvas-bound
listeners or cached scene coordinates. Destroy removes the generated wrapper and
detaches, but does not destroy, host-owned content. Hosts remain responsible for
custom element, timer and event-handler cleanup. A manual destroy moves focus from
inside the retiring overlay to the live chart canvas unless a replacement binding
was installed reentrantly or the host moved focus to an outside/reparented control; chart teardown does not focus its retiring canvas.

The customization demo offers an unchecked overlay toggle with a host information
label and Fit button. Slot DOM, content, visibility and host placement are not
included in the UI preference or workspace documents. Fixed DOM slots are web-only;
there is no native overlay facade. Modeled DOM tests cover ownership, fallback,
failure, reentry and focus reconciliation, not actual browser CSS/pixels/input or
assistive-technology behavior.
