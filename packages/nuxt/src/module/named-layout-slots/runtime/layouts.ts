import { computed, defineComponent, Fragment, getCurrentInstance, h, inject, onActivated, onDeactivated, onMounted, onScopeDispose, onUpdated, provide, shallowRef, type Slots } from "vue";
// @ts-expect-error virtual file
import { NuxtLayout } from "#build/dxup/layouts.mjs";
import { injectionKey } from "./registry";

interface SlotsLayer {
  slots: Slots;
  uid: number;
  /** The page is still rendering inside a pending `<Suspense>`, so its slots are not exposed yet */
  pending: boolean;
}

export default defineComponent((props, ctx) => {
  const layers: SlotsLayer[] = [];
  const slots = shallowRef<Slots | null>(null);
  let layerUid = 0;
  let resolveReady: () => void;

  function getSettledLayers() {
    return layers.filter((layer) => !layer.pending);
  }

  function update() {
    const settled = getSettledLayers();
    // a single active page needs no merging
    slots.value = settled.length > 1 ? mergeLayers(settled) : settled[0]?.slots ?? null;
  }

  /**
   * Exposes the slots of the pages that rendered inside a pending `<Suspense>`: the page they
   * replace is leaving, or they got mounted.
   */
  function settle() {
    let changed = false;
    for (const layer of layers) {
      if (layer.pending) {
        layer.pending = false;
        changed = true;
      }
    }
    if (changed) {
      update();
    }
  }

  provide(injectionKey, {
    slots,
    ready: new Promise<void>((resolve) => {
      resolveReady = resolve;
    }),
    use(value) {
      const layer: SlotsLayer = {
        slots: value,
        uid: layerUid++,
        pending: false,
      };
      function add() {
        if (layers.every((entry) => entry.slots !== value)) {
          layers.push(layer);
          update();
        }
      }
      function remove() {
        const index = layers.findIndex((entry) => entry.slots === value);
        if (index !== -1) {
          layers.splice(index, 1);
          // the previous page leaves once the next one has settled, in the same synchronous
          // step of the suspense's resolve, so the pages that rendered meanwhile take over
          // without a render in between
          if (layer.pending) {
            update();
          }
          else {
            settle();
          }
        }
      }

      if (import.meta.client) {
        // a page rendering inside a pending <Suspense> while another page is shown, e.g. a parent
        // page whose child page awaits its setup, must not expose its slots before its content
        const suspense = getCurrentInstance()?.suspense;
        layer.pending = !!suspense?.pendingBranch && !!suspense.activeBranch && !suspense.isHydrating;
        onMounted(settle);
      }
      add();
      // a page keeps providing its slots until it is unmounted,
      // so a navigation only switches the slots once the next page has settled
      onScopeDispose(remove);
      // a page cached by <KeepAlive> must not provide slots while inactive
      onDeactivated(remove);
      onActivated(add);
      resolveReady?.();
    },
    invalidate() {
      const settled = getSettledLayers();
      // always expose a fresh object; reactivity propagates correctly only on identity change
      slots.value = settled.length ? mergeLayers(settled) : null;
    },
    getOwner(name) {
      const settled = getSettledLayers();
      for (let i = settled.length - 1; i >= 0; i--) {
        if (settled[i].slots[name]) {
          return settled[i].uid;
        }
      }
    },
  });

  return () => h(NuxtLayout, props, ctx.slots);
});

/**
 * Merges the slots of all mounted pages. The most recently mounted pages have
 * a higher priority.
 * @param layers
 */
function mergeLayers(layers: SlotsLayer[]): Slots {
  const merged: Slots = Object.create(null);
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const key in layers[i].slots) {
      if (!(key in merged)) {
        Object.defineProperty(merged, key, {
          enumerable: true,
          configurable: true,
          // resolve lazily, so re-rendered pages provide their current slot functions
          get: () => {
            for (let j = layers.length - 1; j >= 0; j--) {
              const slot = layers[j].slots[key];
              if (slot) {
                return slot;
              }
            }
          },
        });
      }
    }
  }
  return merged;
}

/**
 * Returns the slots forwarded by the active page via named layout slots.
 */
export function useLayoutSlots() {
  const registry = inject(injectionKey, null);
  return computed(() => registry?.slots.value ?? {});
}

export const LayoutSlot = defineComponent({
  props: {
    name: {
      type: String,
      required: true,
    },
  },
  setup(props, ctx) {
    const registry = inject(injectionKey, null);
    const currentInstance = getCurrentInstance();

    const render = () => {
      const slot =
        // for nested layouts or explicit imports,
        // the parent layout should be able to render the raw slots as fallback
        registry?.slots.value?.[props.name] ?? currentInstance?.parent?.slots[props.name];
      // an unprovided slot falls back to the children of the original `<slot>`
      // ensure the `<Fragment>` always receives an array so Vue SSR can safely render it
      const children = slot?.(ctx.attrs) ?? ctx.slots.default?.() ?? [];
      // key the content by the forward that provides it, so it lives and dies
      // with its page instead of being patched across page boundaries
      return h(Fragment, { key: registry?.getOwner(props.name) ?? -1 }, children);
    };

    if (import.meta.server && registry && !registry.slots.value?.[props.name]) {
      return registry.ready.then(() => render);
    }
    return render;
  },
});

export const LayoutSlotsForward = defineComponent((props, ctx) => {
  const registry = inject(injectionKey, null);

  registry?.use(ctx.slots);

  // invalidate the registry when conditional slots are re-rendered (`ctx.slots` is mutated in place)
  if (import.meta.client && registry) {
    let keys = Object.keys(ctx.slots).join("\0");
    onUpdated(() => {
      const next = Object.keys(ctx.slots).join("\0");
      if (next !== keys) {
        keys = next;
        registry.invalidate();
      }
    });
  }

  return () => {
    const vnodes = ctx.slots.default?.();
    // do not break the single-root structure of page components
    return vnodes?.length === 1 ? vnodes[0] : vnodes;
  };
});
