package com.opendungeonmaster.app;

import android.app.ActivityManager;
import android.content.Context;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.Iterator;
import java.util.regex.Pattern;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The stateless pieces of running the phone-hosted server: reading payload
 * descriptions, unpacking the zip, probing ports, minting the database key,
 * sizing the Node heap and finding the Wi-Fi address. {@link WorldRuntime}
 * owns the process and its state; this keeps it under a readable size.
 */
final class WorldEnvironment {

    private static final String TAG = "ODMWorld";

    private WorldEnvironment() {}

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /** The payload description in a directory, or null when there is none or it is unreadable. */
    static JSONObject readInfo(File dir) {
        try {
            byte[] bytes = Files.readAllBytes(new File(dir, PayloadStore.MARKER).toPath());
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Streams a payload zip into a directory. The marker entry sits
     * anywhere in the zip, so it is held back and written last: a tree
     * with a marker is a complete tree.
     */
    static void unpackZip(InputStream source, File target) throws IOException {
        String root = target.getCanonicalPath() + File.separator;
        String markerPath = new File(target, PayloadStore.MARKER).getCanonicalPath();
        byte[] marker = null;
        try (ZipInputStream zip = new ZipInputStream(source)) {
            ZipEntry entry;
            byte[] buf = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(target, entry.getName());
                String path = out.getCanonicalPath();
                if (!path.startsWith(root)) throw new IOException("Bad zip entry " + entry.getName());
                if (entry.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("mkdir " + out);
                    continue;
                }
                if (path.equals(markerPath)) {
                    marker = readAll(zip);
                    zip.closeEntry();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
                try (OutputStream file = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) file.write(buf, 0, n);
                }
                zip.closeEntry();
            }
        }
        if (marker == null) throw new IOException("The payload has no " + PayloadStore.MARKER);
        PayloadStore.writeMarker(target, marker);
    }

    /** Opens a file of the app's web assets by path under assets/public (the Capacitor www folder). */
    interface AssetSource {
        InputStream open(String path) throws IOException;
    }

    /** The manifest the renderer build writes beside the game bundle: host folder to file names. */
    static final String LOCAL_ASSET_MANIFEST = "game/public/manifest.json";

    /**
     * Where a host folder lives among the web assets. Mirrors localFolder()
     * in src/shared/local-assets.ts: the painted icons and the stylesheet's
     * furniture keep their old folders, the rest mirrors the server's
     * public tree under game/public.
     */
    static String localFolder(String hostDir) {
        if (hostDir.startsWith("/assets/icons/")) return "game/icons/" + hostDir.substring("/assets/icons/".length());
        if (hostDir.startsWith("/assets/ui/")) return "game/ui-art/" + hostDir.substring("/assets/ui/".length());
        return "game/public" + hostDir;
    }

    /**
     * Puts the art the app carries in its web assets (tiles, icons, props,
     * the dice) back into the server's public tree, where browser players
     * joining this phone's world fetch it from. The payload zip leaves it
     * out (mobile/scripts/bundle-android-payload.mjs) so the same bytes do
     * not ship twice. Returns how many files were written; none when this
     * build has no manifest, in which case the payload is taken as
     * complete.
     */
    static int copyLocalAssets(AssetSource source, File target) throws IOException {
        JSONObject manifest;
        try (InputStream in = source.open(LOCAL_ASSET_MANIFEST)) {
            manifest = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (IOException e) {
            return 0;
        } catch (org.json.JSONException e) {
            throw new IOException("Unreadable " + LOCAL_ASSET_MANIFEST, e);
        }
        String root = target.getCanonicalPath() + File.separator;
        int copied = 0;
        byte[] buf = new byte[65536];
        for (Iterator<String> dirs = manifest.keys(); dirs.hasNext(); ) {
            String hostDir = dirs.next();
            JSONArray files = manifest.optJSONArray(hostDir);
            if (files == null) continue;
            File folder = new File(target, "public" + hostDir);
            if (!folder.getCanonicalPath().startsWith(root)) throw new IOException("Bad manifest folder " + hostDir);
            if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("mkdir " + folder);
            for (int i = 0; i < files.length(); i++) {
                String name = files.optString(i, "");
                if (name.isEmpty() || name.contains("/") || name.equals("..")) continue;
                try (InputStream in = source.open(localFolder(hostDir) + name);
                     OutputStream out = new FileOutputStream(new File(folder, name))) {
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                copied += 1;
            }
        }
        return copied;
    }

    static boolean portFree(int candidate) {
        try (ServerSocket probe = new ServerSocket(candidate)) {
            probe.setReuseAddress(true);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    static int freePort() throws IOException {
        try (ServerSocket any = new ServerSocket(0)) {
            return any.getLocalPort();
        }
    }

    /**
     * The server refuses to run without an encryption key even though the
     * built-in SQLite engine on the phone cannot encrypt; one is minted per
     * install so the same key works if a native engine ever ships.
     */
    static String dbEncryptionKey(File dataDir) throws IOException {
        File keyFile = new File(dataDir, "db-key");
        if (keyFile.exists()) {
            String existing = new String(Files.readAllBytes(keyFile.toPath()), StandardCharsets.UTF_8).trim();
            if (!existing.isEmpty()) return existing;
        }
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        Files.write(keyFile.toPath(), hex.toString().getBytes(StandardCharsets.UTF_8));
        return hex.toString();
    }

    /** V8 old-space cap in MB from the device's RAM: 256 up to 4 GB, 384 up to 8 GB, 512 beyond. */
    static int heapMegabytes(Context app) {
        long total = 0;
        ActivityManager manager = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(info);
            total = info.totalMem;
        }
        long gib = 1024L * 1024 * 1024;
        if (total > 8 * gib) return 512;
        if (total > 4 * gib) return 384;
        return 256;
    }

    /**
     * The address friends on the same network use; empty when there is no
     * Wi-Fi address. Mirrors the desktop's picker (src/shared/lan.ts): the
     * phone's mobile-data and VPN interfaces are left out, since a friend at
     * the table cannot reach them (a carrier hands out 10.x addresses too),
     * and private ranges come first.
     */
    static String lanOrigin(int listenPort) {
        if (listenPort <= 0) return "";
        List<String[]> found = new ArrayList<>();
        try {
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (InetAddress address : Collections.list(iface.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) {
                        found.add(new String[] { iface.getName(), address.getHostAddress() });
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "No LAN address: " + e.getMessage());
        }
        String address = pickLanAddress(found);
        return address.isEmpty() ? "" : "http://" + address + ":" + listenPort;
    }

    // Mobile data (rmnet on Qualcomm, ccmni on MediaTek, the IPv4 shim clat
    // and v4-), VPNs and tunnels: no way in for somebody on the same Wi-Fi.
    private static final Pattern NOT_LAN = Pattern.compile("^(rmnet|ccmni|pdp|clat|v4-|tun|ppp|ipsec|dummy|ifb|sit|ip6tnl)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PRIVATE_V4 = Pattern.compile("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)");

    /** The address to offer, from { interface name, IPv4 address } pairs in interface order; "" when none fits. */
    static String pickLanAddress(List<String[]> interfaces) {
        String fallback = "";
        for (String[] entry : interfaces) {
            if (NOT_LAN.matcher(entry[0]).find()) continue;
            if (PRIVATE_V4.matcher(entry[1]).find()) return entry[1];
            if (fallback.isEmpty()) fallback = entry[1];
        }
        return fallback;
    }
}
