import { refusedAfter } from "../shared/broker";

type Publication = { published: string[]; refused: string[] };

export function createPublicUrlSync(deps: {
  token: () => string | null;
  origin: () => string;
  lanOrigin: () => string;
  status: () => { state: string; url: string };
  patch: (origin: string, token: string, settings: { publicUrl: string }) => Promise<unknown>;
  owned: (origin: string, token: string) => Promise<string[]>;
  publish: (input: { codes: readonly string[]; url: string; secretFor: (code: string) => string }) => Promise<Publication>;
  drop: (input: { codes: readonly string[]; secretFor: (code: string) => string }) => Promise<string[]>;
  publishedCodes: () => string[];
  setPublishedCodes: (codes: readonly string[]) => void;
  secretFor: (code: string) => string;
  refusedCodes: () => string[];
  setRefusedCodes: (codes: string[]) => void;
}): () => Promise<void> {
  const run = async (): Promise<void> => {
    const token = deps.token();
    const origin = deps.origin();
    const status = deps.status();
    const live = status.state === "running" ? status.url : "";
    if (live) {
      if (!token || !origin) return;
      await deps.patch(origin, token, { publicUrl: live }).catch(() => undefined);
      const codes = await deps.owned(origin, token);
      const { published, refused } = await deps.publish({ codes, url: live, secretFor: deps.secretFor });
      deps.setRefusedCodes(refusedAfter(deps.refusedCodes(), { codes, published, refused }));
      deps.setPublishedCodes([...new Set([...published, ...deps.publishedCodes()])]);
      return;
    }
    deps.setRefusedCodes([]);
    // Heal the world's own invite links before broker cleanup can wait on
    // one or more slow DELETE requests.
    if (token && origin) {
      await deps.patch(origin, token, { publicUrl: deps.lanOrigin() }).catch(() => undefined);
    }
    const stale = deps.publishedCodes();
    if (stale.length > 0) {
      const failed = await deps.drop({ codes: stale, secretFor: deps.secretFor });
      deps.setPublishedCodes(failed);
    }
  };
  let tail: Promise<void> = Promise.resolve();
  return () => {
    // A Stop sync must run after any PUT already on the wire, so its DELETE
    // cannot be undone by an older publish response.
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}
