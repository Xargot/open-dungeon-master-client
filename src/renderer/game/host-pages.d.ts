// The route table (index.tsx) imports the server's page components through
// the bundler's "@/" alias (scripts/build-renderer.mjs); tsc only needs to
// know they are page modules. A script file, not a module, so this is an
// ambient declaration rather than an augmentation.
declare module "@/app/*" {
  const page: import("preact").ComponentType<{ params: unknown; searchParams?: unknown }>;
  export default page;
}

// The server's device panel (src/components/DeviceSettings.tsx), mounted on
// the shell's Settings screen.
declare module "@/components/DeviceSettings" {
  import type { ComponentType } from "preact/compat";
  export const DeviceSettings: ComponentType<Record<string, never>>;
}

// The server's page skeletons (src/components/PageSkeleton.tsx): the shape a
// page holds while its code loads, shown by the game router's Suspense.
declare module "@/components/PageSkeleton" {
  import type { ComponentType } from "preact/compat";
  export type SkeletonKind = "home" | "lobby" | "table" | "roster" | "sheet" | "shelf" | "hub" | "list" | "flat";
  export const PageSkeleton: ComponentType<{ kind?: SkeletonKind; className?: string }>;
}

// The server's confirm and notice host (src/components/ui/ConfirmDialog.tsx),
// which its root layout mounts; the game root mounts it here, so appConfirm
// and appNotice draw the app's own dialog instead of the web view's.
declare module "@/components/ui/ConfirmDialog" {
  import type { ComponentType } from "preact/compat";
  export const ConfirmHost: ComponentType<Record<string, never>>;
}
