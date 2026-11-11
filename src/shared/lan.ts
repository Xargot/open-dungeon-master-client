// Where friends on the same network reach a world this computer hosts.
// Mirrors the server's own picker (src/lib/server-address.ts there): every
// non-loopback IPv4 address, virtual bridges and link-local left out,
// private ranges first. The desktop shell shows one address, the first.

export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type Interfaces = Record<string, InterfaceAddress[] | undefined>;

// A container bridge or a virtual pair is an address only this machine can
// reach; offering it as a way in sends a guest nowhere.
const VIRTUAL_INTERFACE = /^(docker\d*|br-[0-9a-f]+|veth|virbr|cni|flannel|podman|vboxnet|vmnet)/i;

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function lanAddresses(interfaces: Interfaces): string[] {
  const out: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      const isV4 = entry.family === "IPv4" || entry.family === 4;
      if (!isV4 || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (!out.includes(entry.address)) out.push(entry.address);
    }
  }
  // Private ranges first: they are the ones a friend on the same Wi-Fi can
  // actually use. A stable sort keeps the interface order within a rank.
  const rank = (address: string) => (PRIVATE_V4.test(address) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// The interfaces as a read finds them, or none when the host refuses the
// read: Node's os.networkInterfaces() throws where enumeration is not
// allowed (a restricted sandbox, Android's SELinux). Sharing on the Wi-Fi
// is a hint, so a refusal reads as "on no network" rather than taking the
// local world's status down with it, and the next read tries again.
export function readInterfaces(read: () => Interfaces): Interfaces {
  try {
    return read();
  } catch {
    return {};
  }
}

// The one address the share row shows, "" when this computer is on no
// network at all.
export function lanOrigin(interfaces: Interfaces, port: number): string {
  const [address] = lanAddresses(interfaces);
  return address && port ? `http://${address}:${port}` : "";
}
