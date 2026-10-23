// "next/dynamic" for the game screens: Preact's lazy and Suspense, with the
// page's own loading element shown while the module arrives. Next's `ssr`
// option means nothing here, since the screens only render on the device.
import { lazy, Suspense, type ComponentType } from "preact/compat";
import type { JSX } from "preact";

type Loaded<P> = ComponentType<P> | { default: ComponentType<P> };

type Options = {
  loading?: () => JSX.Element | null;
  ssr?: boolean;
};

export default function dynamic<P extends object>(
  load: () => Promise<Loaded<P>>,
  options: Options = {},
): ComponentType<P> {
  // A loader may resolve to the component itself (the `.then(m => m.X)`
  // form the server uses) or to a module with a default export.
  const Lazy = lazy(() =>
    load().then((loaded) => (typeof loaded === "object" && "default" in loaded ? loaded : { default: loaded })),
  );
  const Loading = options.loading;
  return function Dynamic(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
