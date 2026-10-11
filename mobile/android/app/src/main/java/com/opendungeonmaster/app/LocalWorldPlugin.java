package com.opendungeonmaster.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.Iterator;
import org.json.JSONObject;

/**
 * The bridge's window into the device-hosted world: start it (the Node
 * child process), stop it, read its status and the tail of its log; and the
 * share tunnel that puts it on the internet. Playing alone needs no
 * notification, so the world runs as a plain child of the app; hosting
 * (sharing) is what starts the foreground service, which keeps the world
 * and the tunnel alive while the host looks at other apps. Everything else
 * the shell does with the world (accounts, settings, opening it) goes over
 * plain HTTP to 127.0.0.1 like any server.
 *
 * Capacitor runs every plugin call of every plugin on one handler thread,
 * so anything that waits on a child process happens on its own worker and
 * resolves the call from there. Changes the native side makes on its own
 * (the server dying, cloudflared exiting, a stop from the notification)
 * reach the bridge as a <code>worldEvent</code>:
 * <code>{ source: "world" | "tunnel", state: "running" | "stopped" | "error", message? }</code>.
 */
@CapacitorPlugin(name = "LocalWorld")
public class LocalWorldPlugin extends Plugin {

    private static final String WORLD_EVENT = "worldEvent";

    private static JSObject toJS(JSONObject json) {
        JSObject object = new JSObject();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            object.put(key, json.opt(key));
        }
        return object;
    }

    private WorldRuntime runtime() {
        return WorldRuntime.get(getContext());
    }

    private ShareTunnel tunnel() {
        return ShareTunnel.get(getContext());
    }

    @Override
    public void load() {
        runtime().setListener(this::emitWorldEvent);
        tunnel().setListener(this::emitWorldEvent);
    }

    private void emitWorldEvent(String source, String state, String message) {
        JSObject data = new JSObject();
        data.put("source", source);
        data.put("state", state);
        if (message != null && !message.isEmpty()) data.put("message", message);
        notifyListeners(WORLD_EVENT, data, false);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(toJS(runtime().status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        Thread worker = new Thread(() -> {
            try {
                runtime().start();
                call.resolve(toJS(runtime().status()));
            } catch (IOException e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not start the world.");
            } catch (RuntimeException e) {
                call.reject("Could not start the world: " + e.getMessage());
            }
        }, "odm-world-start");
        worker.start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Thread worker = new Thread(() -> {
            tunnel().stop();
            WorldService.stop(getContext());
            runtime().stop();
            call.resolve(toJS(runtime().status()));
        }, "odm-world-stop");
        worker.start();
    }

    @PluginMethod
    public void log(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", runtime().tailLog(16_384));
        call.resolve(result);
    }

    // ---------- moving the world (src/shared/world-transfer.ts) ----------
    //
    // The world's own server packs and checks the archive in its
    // world-transfer folder; these only move the file between there and
    // wherever the person keeps it, through the system's file chooser.

    private static final String PACKED_NAME = "odm-world-[0-9TZ-]+\\.tar\\.gz";

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
    }

    private static String randomName() {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        StringBuilder name = new StringBuilder("import-");
        for (byte b : bytes) name.append(String.format("%02x", b));
        return name.append(".tar.gz").toString();
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (RuntimeException ignored) {
            // A provider that cannot say; the suggested name will do.
        }
        return fallback;
    }

    private static Uri resultUri(ActivityResult result) {
        Intent data = result.getData();
        return result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
    }

    /** Lets the person pick a world archive and copies it beside the world's database. Resolves { name }, "" when the picker is closed. */
    @PluginMethod
    public void pickArchive(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "pickedArchive");
    }

    @ActivityCallback
    private void pickedArchive(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = resultUri(result);
        if (uri == null) {
            JSObject none = new JSObject();
            none.put("name", "");
            call.resolve(none);
            return;
        }
        new Thread(() -> {
            File dir = runtime().transferDir();
            String name = randomName();
            File target = new File(dir, name);
            try {
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not make room for the file.");
                try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(target)) {
                    if (in == null) throw new IOException("The file could not be opened.");
                    copy(in, out);
                }
                JSObject picked = new JSObject();
                picked.put("name", name);
                call.resolve(picked);
            } catch (IOException | RuntimeException e) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "The file could not be copied.");
            }
        }, "odm-world-pick").start();
    }

    /** Asks where to keep the packed world and copies it there. Resolves { saved, label }. */
    @PluginMethod
    public void saveArchive(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || !name.matches(PACKED_NAME) || !new File(runtime().transferDir(), name).isFile()) {
            call.reject("The packed world is missing.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/gzip");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("suggested", name));
        startActivityForResult(call, intent, "savedArchive");
    }

    @ActivityCallback
    private void savedArchive(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = resultUri(result);
        if (uri == null) {
            JSObject none = new JSObject();
            none.put("saved", false);
            call.resolve(none);
            return;
        }
        String name = call.getString("name", "");
        new Thread(() -> {
            File source = new File(runtime().transferDir(), name);
            try (InputStream in = new FileInputStream(source);
                 OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("That place cannot be written to.");
                copy(in, out);
                JSObject saved = new JSObject();
                saved.put("saved", true);
                saved.put("label", displayName(uri, call.getString("suggested", name)));
                call.resolve(saved);
            } catch (IOException | RuntimeException e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "The world could not be saved there.");
            }
        }, "odm-world-save").start();
    }

    // ---------- sharing ----------

    @PluginMethod
    public void shareStatus(PluginCall call) {
        call.resolve(toJS(tunnel().status()));
    }

    /**
     * Starts cloudflared: with a broker token (and the address the broker
     * promised) as a named tunnel, otherwise as a quick tunnel whose address
     * comes back in the result. Hosting begins here, so the foreground
     * service starts first and stops again if the tunnel does not come up.
     * A stop that lands while the tunnel is still coming up rejects with
     * the code "stopped" so the bridge can tell it from a failure.
     */
    @PluginMethod
    public void shareStart(PluginCall call) {
        String token = call.getString("token", "");
        String promised = call.getString("url", "");
        int port = call.getInt("port", 0);
        Thread worker = new Thread(() -> {
            try {
                WorldService.start(getContext(), "Opening a public address for your world.");
                String url;
                if (token != null && !token.isEmpty()) {
                    tunnel().startNamed(token, promised != null ? promised : "");
                    url = promised != null ? promised : "";
                } else {
                    url = tunnel().startQuick(port);
                }
                WorldService.start(getContext(), "Friends can join at " + url + " while this stays on.");
                JSObject result = new JSObject();
                result.put("url", url);
                call.resolve(result);
            } catch (ShareTunnel.StoppedException e) {
                WorldService.stop(getContext());
                call.reject(e.getMessage(), "stopped");
            } catch (IOException e) {
                tunnel().stop();
                WorldService.stop(getContext());
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not open a public address.");
            } catch (RuntimeException e) {
                tunnel().stop();
                WorldService.stop(getContext());
                call.reject("Could not open a public address: " + e.getMessage());
            }
        }, "odm-share-start");
        worker.start();
    }

    @PluginMethod
    public void shareStop(PluginCall call) {
        Thread worker = new Thread(() -> {
            tunnel().stop();
            WorldService.stop(getContext());
            call.resolve(toJS(tunnel().status()));
        }, "odm-share-stop");
        worker.start();
    }
}
