package com.opendungeonmaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Where the app keeps what signs a player in: bearer tokens, the passwords
 * it made up for room-code accounts, the table secrets it registers room
 * codes with, and the device world's own account. mobile/src/secret-store.ts
 * is the other half.
 *
 * Each value is sealed with AES-GCM under a key that lives in the Android
 * Keystore and never leaves it, and the sealed values sit in their own
 * preferences file, which the backup rules leave out of cloud backup and
 * device transfer. They used to sit in plain Capacitor preferences, which
 * Auto Backup copied off the phone along with the saved-server list.
 *
 * A value that will not open (the key is gone: a restore onto another
 * phone, or a reset Keystore) reads as absent, so the app asks the player
 * to sign in again rather than failing.
 *
 * get({ key }) -> { value: string | null }
 * set({ key, value })
 * remove({ key })
 */
@CapacitorPlugin(name = "OdmSecrets")
public class SecretStorePlugin extends Plugin {

    static final String PREFS = "odm_secrets";
    private static final String KEY_ALIAS = "odm-secrets-v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    static String seal(SecretKey key, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    static String open(SecretKey key, String stored) throws Exception {
        int split = stored.indexOf(':');
        if (split <= 0) throw new IllegalArgumentException("not a sealed value");
        byte[] iv = Base64.decode(stored.substring(0, split), Base64.NO_WRAP);
        byte[] sealed = Base64.decode(stored.substring(split + 1), Base64.NO_WRAP);
        if (iv.length != IV_BYTES) throw new IllegalArgumentException("bad iv");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        return new String(cipher.doFinal(sealed), StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("A key is required.");
            return;
        }
        JSObject result = new JSObject();
        String stored = prefs().getString(name, null);
        if (stored == null) {
            result.put("value", JSObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            result.put("value", open(key(), stored));
        } catch (Exception unreadable) {
            // Sealed under a key this phone no longer has: as good as absent.
            prefs().edit().remove(name).apply();
            result.put("value", JSObject.NULL);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || name.isEmpty() || value == null) {
            call.reject("A key and a value are required.");
            return;
        }
        try {
            prefs().edit().putString(name, seal(key(), value)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not keep that secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name != null && !name.isEmpty()) {
            prefs().edit().remove(name).apply();
        }
        call.resolve();
    }
}
