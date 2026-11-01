export interface NativeRect { x: number; y: number; width: number; height: number }
export interface NativeLayout { bounds: NativeRect; occlusions: NativeRect[]; visible: boolean; scale: number }
export interface NativeBoardApi {
  open(key: {addonId: string; viewId: string}): Promise<{id: string} | null>;
  send(id: string, packet: unknown): void;
  layout(id: string, layout: NativeLayout): void;
  close(id: string): Promise<void>;
  subscribe(id: string, listener: (packet: unknown) => void): () => void;
}

export function nativeLayout(raw: unknown): NativeLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as NativeLayout;
  const rect = (r: NativeRect) => !!r && ['x','y','width','height'].every(k =>
    typeof r[k as keyof NativeRect] === 'number' && Number.isFinite(r[k as keyof NativeRect]) && Math.abs(r[k as keyof NativeRect]) <= 32768)
    && r.width >= 0 && r.height >= 0;
  return rect(p.bounds) && Array.isArray(p.occlusions) && p.occlusions.length <= 64 && p.occlusions.every(rect)
    && typeof p.visible === 'boolean' && Number.isFinite(p.scale) && p.scale >= 0.25 && p.scale <= 8 ? p : null;
}
