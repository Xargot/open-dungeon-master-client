package com.opendungeonmaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Runs the bundled Open Dungeon Master server on this phone. The APK ships a
 * Node runtime as a native library (libnode.so, executable from the app's
 * native library directory) and the server as a zip in assets; the first
 * start unpacks the server into app storage and every start launches
 * <code>node server.js</code> as a child process listening on all
 * interfaces, so friends on the same Wi-Fi can join. Mirrors the desktop
 * shell's LocalServer (src/main/local-server.ts) in shape and behavior.
 *
 * Threading: start() holds the runtime's monitor so two starts cannot race,
 * and it can hold it for a while (a payload unpack, then up to ninety
 * seconds of health polling). stop() never takes that monitor: it flips a
 * flag and kills the child, and every wait inside start() watches the flag,
 * so a stop from the notification or the bridge returns promptly. Both are
 * meant for background threads; stop() waits up to five seconds for the
 * child to exit.
 */
public final class WorldRuntime {

    private static final String TAG = "ODMWorld";
    private static final int DEFAULT_PORT = 3210;
    private static final long HEALTH_TIMEOUT_MS = 90_000;
    private static final long LOG_CAP_BYTES = 1024L * 1024;
    private static final int PORT_ATTEMPTS = 3;
    private static final String PAYLOAD_ASSET = "server-payload.zip";
    private static final String PAYLOAD_INFO_ASSET = "server-payload.json";
    /** The Capacitor www folder inside the APK's assets. */
    private static final String WWW_ASSETS = "public/";
    private static final String PREFS = "odm-world";

    /** Thrown inside start() when stop() cut it short: the outcome is "stopped", not a failure. */
    private static final class StoppedException extends IOException {
        StoppedException() {
            super("The world was stopped before it came up.");
        }
    }

    private static WorldRuntime instance;

    public static synchronized WorldRuntime get(Context context) {
        if (instance == null) {
            instance = new WorldRuntime(context.getApplicationContext());
        }
        return instance;
    }

    private final Context app;
    private final PayloadStore store;
    private final AtomicReference<Process> process = new AtomicReference<>();
    /** Guards the state transitions that start(), stop() and the exit watcher race on. */
    private final Object stateLock = new Object();
    private volatile boolean stopRequested;
    private volatile int port;
    private volatile String state = "stopped";
    private volatile String error = "";
    /** The LAN address for the current run; computed once the world is up. */
    private volatile String lanOrigin = "";
    /**
     * Whether friends on the same Wi-Fi can reach the world. Off at every
     * app start, as on the desktop: the world answers on the phone alone
     * until the player shares it on the Wi-Fi (setLanSharing).
     */
    private volatile boolean sharedOnLan;
    /** Set while setLanSharing restarts the world, whose stop must not read as the world going away. */
    private volatile boolean restarting;
    private volatile WorldEventListener listener;
    /** The payload description never changes while the app runs, so it is read once. */
    private volatile boolean bundledLoaded;
    private volatile JSONObject bundled;
    private volatile Boolean availableCache;

    private WorldRuntime(Context app) {
        this.app = app;
        this.store = new PayloadStore(app.getFilesDir());
    }

    /** Who hears about the server dying or a stop finishing; the plugin registers itself in load(). */
    public void setListener(WorldEventListener listener) {
        this.listener = listener;
    }

    private void emit(String eventState, String message) {
        WorldEventListener target = listener;
        if (target == null) return;
        try {
            target.onWorldEvent("world", eventState, message);
        } catch (RuntimeException e) {
            Log.w(TAG, "World listener failed: " + e.getMessage());
        }
    }

    // ---------- paths ----------

    private File serverDir() {
        return store.serverDir();
    }

    private File dataDir() {
        return new File(app.getFilesDir(), "data");
    }

    /** Where the world's server stages a world archive it packs or checks (its world-archive.ts). */
    public File transferDir() {
        return new File(dataDir(), "world-transfer");
    }

    private File dbFile() {
        return new File(dataDir(), "odm.sqlite");
    }

    public File logFile() {
        return new File(app.getFilesDir(), "local-server.log");
    }

    private File nodeBinary() {
        return new File(app.getApplicationInfo().nativeLibraryDir, "libnode.so");
    }

    // ---------- payload ----------

    private JSONObject bundledInfo() {
        if (!bundledLoaded) {
            JSONObject info;
            try (InputStream in = app.getAssets().open(PAYLOAD_INFO_ASSET)) {
                info = new JSONObject(new String(WorldEnvironment.readAll(in), StandardCharsets.UTF_8));
            } catch (Exception e) {
                info = null;
            }
            bundled = info;
            bundledLoaded = true;
        }
        return bundled;
    }

    /** True when this build carries both a runtime and a server payload. */
    public boolean available() {
        Boolean cached = availableCache;
        if (cached == null) {
            cached = nodeBinary().exists() && bundledInfo() != null;
            availableCache = cached;
        }
        return cached;
    }

    /** Unpacks the bundled server when it is newer than the one on disk, keeping player data. */
    private void ensurePayload() throws IOException {
        JSONObject fresh = bundledInfo();
        if (fresh == null) throw new IOException("This build has no bundled server payload.");
        store.recover();
        JSONObject current = WorldEnvironment.readInfo(serverDir());
        String builtAt = fresh.optString("builtAt", "");
        if (current != null && builtAt.equals(current.optString("builtAt", ""))) return;
        store.upgrade(this::unpackInto);
        Log.i(TAG, "Unpacked server payload " + builtAt);
    }

    /**
     * Writes the bundled payload into a directory: the art first, the zip
     * last, since the zip carries the marker that says the tree is complete
     * and it must not be written before everything else is.
     */
    private void unpackInto(File target) throws IOException {
        int art = WorldEnvironment.copyLocalAssets(
                (path) -> app.getAssets().open(WWW_ASSETS + path), target);
        try (InputStream in = new BufferedInputStream(app.getAssets().open(PAYLOAD_ASSET))) {
            WorldEnvironment.unpackZip(in, target);
        }
        Log.i(TAG, "Restored " + art + " art files from the app's own copy");
    }

    /**
     * Unpacks the bundled server again whatever the build stamps say,
     * keeping the player's folders (PayloadStore.PRESERVED), and starts the
     * world again when it was awake or had failed; a world asleep stays
     * asleep. For a tree damaged after the fact, which the stamp cannot
     * tell: the desktop shell's LocalServer.repair(). Holds the start
     * monitor so no start launches from a tree being replaced; stop() takes
     * no monitor, so it cannot deadlock from here. Returns whether the world
     * was started again.
     */
    public synchronized boolean repair() throws IOException {
        String before = state;
        boolean again = "running".equals(before) || "error".equals(before);
        stop();
        store.upgrade(this::unpackInto);
        Log.i(TAG, "Rebuilt the server payload");
        if (again) start();
        return again;
    }

    /**
     * Shares the world on the Wi-Fi, or stops. The server picks its address
     * when it boots, so a running world starts again on the same port
     * (pickPort keeps it) and a share tunnel to 127.0.0.1 carries on; an
     * open page's stream reconnects by itself. Turning it on with no Wi-Fi
     * address is refused before anything restarts. Holds the start monitor,
     * like repair(), so no other start runs in between.
     */
    public synchronized void setLanSharing(boolean on) throws IOException {
        if (sharedOnLan == on) return;
        String before = state;
        boolean up = "running".equals(before) || "starting".equals(before);
        if (on && WorldEnvironment.lanOrigin(up && port > 0 ? port : DEFAULT_PORT).isEmpty()) {
            throw new IOException("This phone is not on a Wi-Fi network right now.");
        }
        sharedOnLan = on;
        if (!up) return;
        // The bridge ends an online share when the world reports "stopped";
        // this stop is only the way to the new address, so it stays quiet.
        // A world that does not come back is reported like one that died.
        restarting = true;
        try {
            stop();
            start();
        } catch (IOException e) {
            emit("error", e.getMessage() != null ? e.getMessage() : "The world did not come back up.");
            throw e;
        } finally {
            restarting = false;
        }
    }

    public boolean sharedOnLan() {
        return sharedOnLan;
    }

    private static JSONObject payloadFacts(JSONObject info) throws JSONException {
        return new JSONObject()
                .put("serverVersion", info.optString("serverVersion", ""))
                .put("builtAt", info.optString("builtAt", ""));
    }

    /**
     * What Troubleshooting's summary says of this world (the bridge lays it
     * out with src/shared/diagnostics.ts): the payload this build ships and
     * the one unpacked, what of the world's data is on disk, and the ids of
     * the installed world packs.
     */
    public JSONObject diagnostics() {
        JSONObject json = new JSONObject();
        try {
            JSONObject info = bundledInfo();
            JSONObject unpacked = WorldEnvironment.readInfo(serverDir());
            json.put("payload", info != null ? payloadFacts(info) : JSONObject.NULL);
            json.put("runTree", unpacked != null ? payloadFacts(unpacked) : JSONObject.NULL);
            json.put("dbPresent", dbFile().exists());
            json.put("keyPresent", new File(dataDir(), "db-key").exists());
            List<String> ids = new ArrayList<>();
            File[] files = new File(serverDir(), "data/worlds").listFiles();
            if (files != null) {
                for (File file : files) {
                    String name = file.getName();
                    if (name.endsWith(".json") && !name.equals("index.json")) ids.add(name.substring(0, name.length() - 5));
                }
            }
            Collections.sort(ids);
            json.put("packs", new JSONArray(ids));
        } catch (JSONException ignored) {
            // JSONObject.put only throws for NaN doubles.
        }
        return json;
    }

    // ---------- process ----------

    private SharedPreferences prefs() {
        return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private int pickPort() throws IOException {
        int wanted = prefs().getInt("port", DEFAULT_PORT);
        if (!WorldEnvironment.portFree(wanted)) {
            wanted = WorldEnvironment.portFree(DEFAULT_PORT) ? DEFAULT_PORT : WorldEnvironment.freePort();
        }
        prefs().edit().putInt("port", wanted).apply();
        return wanted;
    }

    public String origin() {
        int current = port;
        return current > 0 ? "http://127.0.0.1:" + current : "";
    }

    /** The address friends on the same network use; empty unless shared on the Wi-Fi and there is a Wi-Fi address. */
    public String lanOrigin() {
        if (!sharedOnLan || !"running".equals(state)) return "";
        String cached = lanOrigin;
        if (cached.isEmpty()) {
            // Wi-Fi may come up after the start; look again only while nothing is cached.
            cached = WorldEnvironment.lanOrigin(port);
            lanOrigin = cached;
        }
        return cached;
    }

    // The code the world's first account must send. A world shared on the
    // Wi-Fi before the host has typed a name could be reached by anyone
    // there, and whoever registers first becomes the world's admin; only
    // this app can work the code out, so only it can. Derived from the database key rather than stored, so
    // it is the same in a new app process around a server still running.
    static String setupCodeFor(String dbKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(("odm-setup-code:" + dbKey).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int index = 0; index < 16; index++) {
                hex.append(String.format("%02x", digest[index]));
            }
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private String setupCode() {
        try {
            return setupCodeFor(WorldEnvironment.dbEncryptionKey(dataDir()));
        } catch (Exception e) {
            return "";
        }
    }

    public JSONObject status() {
        JSONObject info = bundledInfo();
        JSONObject json = new JSONObject();
        try {
            boolean ok = available();
            String current = state;
            boolean running = "running".equals(current);
            json.put("available", ok);
            json.put("state", ok ? current : "unavailable");
            json.put("origin", running ? origin() : "");
            json.put("lanOrigin", running ? lanOrigin() : "");
            json.put("sharedOnLan", sharedOnLan);
            json.put("firstRun", !dbFile().exists());
            json.put("setupCode", running ? setupCode() : "");
            json.put("serverVersion", info != null ? info.optString("serverVersion", "") : "");
            json.put("error", error);
        } catch (Exception ignored) {
            // JSONObject.put only throws for NaN doubles.
        }
        return json;
    }

    private boolean healthy() {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(origin() + "/api/health").openConnection();
            conn.setConnectTimeout(2000);
            conn.setReadTimeout(2000);
            int code = conn.getResponseCode();
            conn.disconnect();
            return code >= 200 && code < 300;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Brings the world up and returns once /api/health answers. A start cut
     * short by stop() returns normally with the state "stopped" rather than
     * throwing; the bridge reads the state from status() either way.
     */
    public synchronized void start() throws IOException {
        Process live = process.get();
        if ("running".equals(state) && live != null && live.isAlive()) return;
        synchronized (stateLock) {
            stopRequested = false;
            state = "starting";
            error = "";
        }
        try {
            if (!nodeBinary().exists()) throw new IOException("This build has no Node runtime for this device.");
            ensurePayload();
            if (stopRequested) throw new StoppedException();
            if (!dataDir().isDirectory() && !dataDir().mkdirs()) throw new IOException("Could not create data dir.");
            File tmp = new File(app.getCacheDir(), "node-tmp");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();
            LogFiles.rotateIfOver(logFile(), LOG_CAP_BYTES);
            String dbKey = WorldEnvironment.dbEncryptionKey(dataDir());
            int candidate = pickPort();
            for (int attempt = 1; ; attempt++) {
                port = candidate;
                long logMark = logFile().length();
                Process child = launch(candidate, dbKey, tmp);
                process.set(child);
                if (stopRequested) throw new StoppedException();
                watch(child);
                if (waitHealthy(child)) {
                    String lan = sharedOnLan ? WorldEnvironment.lanOrigin(candidate) : "";
                    synchronized (stateLock) {
                        if (stopRequested) throw new StoppedException();
                        lanOrigin = lan;
                        state = "running";
                    }
                    prefs().edit().putInt("port", candidate).apply();
                    Log.i(TAG, "World running on port " + candidate);
                    return;
                }
                if (stopRequested) throw new StoppedException();
                // The child exited during startup. The port probe in pickPort()
                // and the server's own bind are separate steps, so another app
                // can take the port in between: try again on a fresh one.
                process.compareAndSet(child, null);
                if (attempt < PORT_ATTEMPTS && addressInUse(logMark)) {
                    candidate = WorldEnvironment.freePort();
                    Log.w(TAG, "Port " + port + " was taken; retrying on " + candidate);
                    continue;
                }
                throw new IOException("The world's server exited during startup (see local-server.log).");
            }
        } catch (IOException e) {
            killQuietly(process.getAndSet(null));
            boolean cancelled;
            synchronized (stateLock) {
                cancelled = stopRequested || e instanceof StoppedException;
                port = 0;
                lanOrigin = "";
                state = cancelled ? "stopped" : "error";
                error = cancelled ? "" : (e.getMessage() != null ? e.getMessage() : "Could not start the world.");
            }
            if (cancelled) return;
            throw e;
        }
    }

    private Process launch(int listenPort, String dbKey, File tmp) throws IOException {
        List<String> command = new ArrayList<>();
        command.add(nodeBinary().getAbsolutePath());
        // V8 flags go before the script, as for any node binary. Without a
        // cap V8 sizes its heap from device RAM and grows until Android's
        // low-memory killer takes the whole app; with one, a runaway session
        // ends in a heap error in local-server.log instead.
        command.add("--max-old-space-size=" + WorldEnvironment.heapMegabytes(app));
        command.add("--max-semi-space-size=16");
        command.add("server.js");
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(serverDir());
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile()));
        Map<String, String> env = builder.environment();
        env.put("NODE_ENV", "production");
        env.put("PORT", String.valueOf(listenPort));
        // The phone alone until the player shares the world on the Wi-Fi;
        // the share tunnel reaches it on 127.0.0.1 either way.
        env.put("HOSTNAME", sharedOnLan ? "0.0.0.0" : "127.0.0.1");
        env.put("SQLITE_DB_PATH", dbFile().getAbsolutePath());
        env.put("DB_ENCRYPTION_KEY", dbKey);
        env.put("ODM_SQLITE_DRIVER", "node");
        // The spells, items, monsters and feats catalogue shipped inside
        // the payload (content/open5e.sqlite); without it every picker in
        // the character builder searches an empty pack.
        env.put("CONTENT_DB_PATH", new File(serverDir(), "content/open5e.sqlite").getAbsolutePath());
        // Tells the server it is the shell's own world, so its admin panel
        // hides what the shell manages (address, sign-ups, voice, Discord).
        env.put("ODM_DEVICE_WORLD", "1");
        env.put("ODM_SETUP_CODE", setupCodeFor(dbKey));
        // The server refuses uploads once the disk would drop below 1 GB
        // free, sized for a server's volume. Plenty of phones live under
        // that, and this disk is the owner's own, so the floor here is only
        // what keeps the database writable.
        env.put("UPLOAD_MIN_FREE_BYTES", String.valueOf(256L * 1024 * 1024));
        env.put("HOME", app.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", tmp.getAbsolutePath());
        env.put("LD_LIBRARY_PATH", app.getApplicationInfo().nativeLibraryDir);
        return builder.start();
    }

    /** True once /api/health answers; false when the child died or a stop was requested. */
    private boolean waitHealthy(Process child) throws IOException {
        long deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (stopRequested || !child.isAlive()) return false;
            if (healthy()) return true;
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while starting.");
            }
        }
        throw new IOException("The world's server did not become ready in time.");
    }

    /** Whether the log written since the launch says the port was taken. */
    private boolean addressInUse(long logMark) {
        String out = LogFiles.readAfter(logFile(), logMark, 65536);
        return out.contains("EADDRINUSE") || out.contains("address already in use");
    }

    /**
     * Notices the server dying after startup: records the error, tells the
     * bridge, and ends the share, since nobody can reach a dead world.
     * Exits during startup are handled by start() itself.
     */
    private void watch(Process child) {
        Thread watcher = new Thread(() -> {
            int code;
            try {
                code = child.waitFor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            String message;
            synchronized (stateLock) {
                if (!process.compareAndSet(child, null)) return;
                if (stopRequested || !"running".equals(state)) return;
                state = "error";
                error = "The world's server stopped unexpectedly (exit " + code + ", see local-server.log).";
                lanOrigin = "";
                message = error;
            }
            Log.w(TAG, message);
            emit("error", message);
            ShareTunnel tunnel = ShareTunnel.get(app);
            if (tunnel.running()) tunnel.stop();
            WorldService.stop(app);
        }, "odm-world-watcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private static void killQuietly(Process child) {
        if (child == null || !child.isAlive()) return;
        child.destroy();
        try {
            if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly();
        } catch (InterruptedException e) {
            child.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Ends the world. Never takes the start monitor, so it returns promptly
     * even while a start is unpacking or polling; that start then finishes
     * as "stopped". Waits up to five seconds for the child, so call it from
     * a background thread.
     */
    public void stop() {
        Process child;
        String before;
        synchronized (stateLock) {
            stopRequested = true;
            before = state;
            state = "stopping";
            child = process.getAndSet(null);
        }
        killQuietly(child);
        synchronized (stateLock) {
            port = 0;
            lanOrigin = "";
            state = "stopped";
            error = "";
        }
        if (!restarting && (child != null || !"stopped".equals(before))) emit("stopped", "");
    }

    public String tailLog(int maxBytes) {
        return LogFiles.tail(logFile(), maxBytes);
    }

    /** Extra environment for diagnostics screens. */
    public Map<String, String> describe() {
        Map<String, String> map = new HashMap<>();
        map.put("node", nodeBinary().getAbsolutePath());
        map.put("server", serverDir().getAbsolutePath());
        map.put("state", state);
        return map;
    }
}
