package com.opendungeonmaster.app;

import android.net.Uri;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Streams a host file into the app cache: the bytes go from the socket to
 * the file and never through JavaScript. The request carries the WebView's
 * cookies for the address (the game web view and this app share one jar,
 * so a session cookie the page holds is sent) plus whatever headers the
 * caller adds (a bearer token for the app's own screens). The size cap is
 * enforced before the body is read when the server declares a length, and
 * while reading otherwise.
 *
 * Redirects are followed here, not by HttpURLConnection: it carried the
 * Cookie header and the caller's headers along to whatever host a redirect
 * named. Now the caller's headers go only to the address it asked for, each
 * hop sends the cookies the WebView holds for that hop's own address (what a
 * browser would), an https address never hands off to plain http, and five
 * hops is the limit.
 *
 * fetchToFile({ url, headers?, folder, fileName, maxBytes? })
 *   -> { path, size, mimeType, suggestedName }
 *
 * folder and fileName are single path segments under the cache directory
 * (letters, digits, dot, dash, underscore; no leading dot). path is a
 * file:// uri; mimeType is the Content-Type without parameters, lower
 * case; suggestedName is the filename from Content-Disposition, or "".
 */
@CapacitorPlugin(name = "OdmDownload")
public class DownloadPlugin extends Plugin {

    static final long MAX_BYTES = 40L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final Pattern SEGMENT = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$");
    private static final Pattern HEADER_NAME = Pattern.compile("^[A-Za-z0-9-]{1,64}$");
    private static final Pattern DISPOSITION_EXTENDED = Pattern.compile(
        "filename\\*\\s*=\\s*[\\w-]+'[^']*'([^;]+)",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern DISPOSITION_QUOTED = Pattern.compile(
        "filename\\s*=\\s*\"((?:[^\"\\\\]|\\\\.)*)\"",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern DISPOSITION_BARE = Pattern.compile("filename\\s*=\\s*([^;]+)", Pattern.CASE_INSENSITIVE);

    @PluginMethod
    public void fetchToFile(PluginCall call) {
        String url = call.getString("url", "");
        String folder = call.getString("folder", "");
        String fileName = call.getString("fileName", "");
        JSObject headers = call.getObject("headers");
        Integer requestedMax = call.getInt("maxBytes", 0);
        long maxBytes = requestedMax != null && requestedMax > 0 ? Math.min(MAX_BYTES, requestedMax) : MAX_BYTES;

        URL target;
        try {
            target = new URL(url != null ? url : "");
        } catch (IOException e) {
            call.reject("That is not a web address.");
            return;
        }
        String protocol = target.getProtocol();
        if (!"http".equals(protocol) && !"https".equals(protocol)) {
            call.reject("Only http and https files can be fetched.");
            return;
        }
        if (folder == null || fileName == null || !SEGMENT.matcher(folder).matches() || !SEGMENT.matcher(fileName).matches()) {
            call.reject("Bad file name.");
            return;
        }
        File dest;
        try {
            File cache = getContext().getCacheDir().getCanonicalFile();
            File dir = new File(cache, folder);
            dest = new File(dir, fileName);
            if (!dest.getCanonicalPath().startsWith(cache.getCanonicalPath() + File.separator)) {
                call.reject("Bad file name.");
                return;
            }
            if (!dir.isDirectory() && !dir.mkdirs()) {
                call.reject("Could not make room in the app cache.");
                return;
            }
        } catch (IOException e) {
            call.reject("Could not make room in the app cache.");
            return;
        }

        final File out = dest;
        final long cap = maxBytes;
        Thread worker = new Thread(() -> {
            try {
                call.resolve(fetch(target, headers, out, cap));
            } catch (IOException e) {
                deleteQuietly(out);
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not read the file.");
            } catch (RuntimeException e) {
                deleteQuietly(out);
                call.reject("Could not read the file: " + e.getMessage());
            }
        }, "odm-download");
        worker.start();
    }

    private static JSObject fetch(URL target, JSObject headers, File dest, long maxBytes) throws IOException {
        URL current = target;
        for (int hop = 0; ; hop++) {
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("Accept", "*/*");
                String cookie = CookieManager.getInstance().getCookie(current.toString());
                if (cookie != null && !cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookie);
                }
                if (headers != null && sameOrigin(current, target)) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String name = keys.next();
                        String value = headers.optString(name, "");
                        if (HEADER_NAME.matcher(name).matches() && value.indexOf('\r') < 0 && value.indexOf('\n') < 0) {
                            connection.setRequestProperty(name, value);
                        }
                    }
                }
                int status = connection.getResponseCode();
                if (isRedirect(status)) {
                    if (hop >= MAX_REDIRECTS) throw new IOException("The server redirected too many times.");
                    current = redirectTarget(current, connection.getHeaderField("Location"));
                    continue;
                }
                return read(connection, status, dest, maxBytes);
            } finally {
                connection.disconnect();
            }
        }
    }

    static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    static boolean sameOrigin(URL a, URL b) {
        return a.getProtocol().equalsIgnoreCase(b.getProtocol())
            && a.getHost().equalsIgnoreCase(b.getHost())
            && (a.getPort() == -1 ? a.getDefaultPort() : a.getPort()) == (b.getPort() == -1 ? b.getDefaultPort() : b.getPort());
    }

    /** Where a redirect points, resolved against the address that sent it; refuses anything but http(s), and https to http. */
    static URL redirectTarget(URL from, String location) throws IOException {
        if (location == null || location.trim().isEmpty()) throw new IOException("The server redirected nowhere.");
        URL next = new URL(from, location.trim());
        String protocol = next.getProtocol();
        if (!"http".equals(protocol) && !"https".equals(protocol)) {
            throw new IOException("Only http and https files can be fetched.");
        }
        if ("https".equals(from.getProtocol()) && "http".equals(protocol)) {
            throw new IOException("The server redirected a secure download to an insecure address.");
        }
        return next;
    }

    private static JSObject read(HttpURLConnection connection, int status, File dest, long maxBytes) throws IOException {
        if (status < 200 || status >= 300) {
            throw new IOException("The server answered " + status + ".");
        }
        String tooBig = "The file is larger than the " + (maxBytes / (1024 * 1024)) + " MB the app can hand off.";
        long declared = connection.getContentLengthLong();
        if (declared > maxBytes) {
            throw new IOException(tooBig);
        }

        long size = 0;
        byte[] buffer = new byte[BUFFER_BYTES];
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            int read;
            while ((read = in.read(buffer)) != -1) {
                size += read;
                if (size > maxBytes) {
                    throw new IOException(tooBig);
                }
                out.write(buffer, 0, read);
            }
        }

        JSObject result = new JSObject();
        result.put("path", Uri.fromFile(dest).toString());
        result.put("size", size);
        result.put("mimeType", mimeOf(connection.getContentType()));
        result.put("suggestedName", filenameFrom(connection.getHeaderField("Content-Disposition")));
        return result;
    }

    private static String mimeOf(String contentType) {
        if (contentType == null) return "";
        int semicolon = contentType.indexOf(';');
        String type = semicolon >= 0 ? contentType.substring(0, semicolon) : contentType;
        return type.trim().toLowerCase(Locale.ROOT);
    }

    /** The name the server gave the file, with any path stripped; "" without one. */
    static String filenameFrom(String disposition) {
        if (disposition == null || disposition.isEmpty()) return "";
        String name = "";
        Matcher extended = DISPOSITION_EXTENDED.matcher(disposition);
        if (extended.find()) {
            name = Uri.decode(extended.group(1).trim());
        }
        if (name.isEmpty()) {
            Matcher quoted = DISPOSITION_QUOTED.matcher(disposition);
            if (quoted.find()) {
                name = quoted.group(1).replaceAll("\\\\(.)", "$1").trim();
            }
        }
        if (name.isEmpty()) {
            Matcher bare = DISPOSITION_BARE.matcher(disposition);
            if (bare.find()) {
                name = bare.group(1).trim();
            }
        }
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        return name.length() > 200 ? name.substring(0, 200) : name;
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            file.deleteOnExit();
        }
    }
}
