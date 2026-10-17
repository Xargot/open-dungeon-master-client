package com.opendungeonmaster.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.URL;
import org.junit.Test;

/** A native download keeps the caller's headers on the address it asked for and follows redirects only where it should. */
public class DownloadRedirectTest {

    @Test
    public void sameOriginComparesSchemeHostAndPort() throws IOException {
        assertTrue(DownloadPlugin.sameOrigin(new URL("https://play.example/a"), new URL("https://PLAY.example:443/b")));
        assertTrue(DownloadPlugin.sameOrigin(new URL("http://192.168.1.5:3005/x"), new URL("http://192.168.1.5:3005/y?z")));
        assertFalse(DownloadPlugin.sameOrigin(new URL("https://play.example/a"), new URL("https://cdn.example/a")));
        assertFalse(DownloadPlugin.sameOrigin(new URL("http://play.example/a"), new URL("https://play.example/a")));
        assertFalse(DownloadPlugin.sameOrigin(new URL("http://192.168.1.5:3005/"), new URL("http://192.168.1.5:3006/")));
    }

    @Test
    public void redirectsResolveAgainstTheAddressThatSentThem() throws IOException {
        URL from = new URL("https://play.example/api/export/1");
        assertEquals("https://play.example/files/w.tar.gz", DownloadPlugin.redirectTarget(from, "/files/w.tar.gz").toString());
        assertEquals("https://cdn.example/w", DownloadPlugin.redirectTarget(from, " https://cdn.example/w ").toString());
        // Plain http may move up to https.
        assertEquals("https://play.example/a", DownloadPlugin.redirectTarget(new URL("http://play.example/x"), "https://play.example/a").toString());
    }

    @Test
    public void redirectsNeverLeaveHttpsOrHttp() throws IOException {
        URL from = new URL("https://play.example/api/export/1");
        for (String bad : new String[] { "http://play.example/w", "file:///data/data/x", "", null }) {
            try {
                DownloadPlugin.redirectTarget(from, bad);
                fail("followed a redirect to " + bad);
            } catch (IOException expected) {
                // Refused.
            }
        }
    }

    @Test
    public void onlyTheRedirectStatusesAreFollowed() {
        for (int status : new int[] { 301, 302, 303, 307, 308 }) assertTrue(DownloadPlugin.isRedirect(status));
        for (int status : new int[] { 200, 204, 300, 304, 305, 404 }) assertFalse(DownloadPlugin.isRedirect(status));
    }
}
