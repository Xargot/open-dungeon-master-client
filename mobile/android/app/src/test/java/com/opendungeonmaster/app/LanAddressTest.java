package com.opendungeonmaster.app;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** The Wi-Fi address a shared world offers friends: never the mobile-data or VPN one, private ranges first. */
public class LanAddressTest {

    private static List<String[]> interfaces(String... pairs) {
        String[][] out = new String[pairs.length / 2][];
        for (int index = 0; index < out.length; index++) out[index] = new String[] { pairs[index * 2], pairs[index * 2 + 1] };
        return Arrays.asList(out);
    }

    @Test
    public void mobileDataAndVpnAreNeverOffered() {
        // A carrier's address is often 10.x, which looks private.
        assertEquals("", WorldEnvironment.pickLanAddress(interfaces("rmnet_data0", "10.45.3.2", "tun0", "10.8.0.2", "v4-rmnet0", "192.0.0.4")));
        assertEquals("192.168.1.9", WorldEnvironment.pickLanAddress(interfaces("rmnet_data0", "10.45.3.2", "wlan0", "192.168.1.9")));
        assertEquals("", WorldEnvironment.pickLanAddress(interfaces("ccmni1", "100.64.2.7")));
    }

    @Test
    public void privateRangesComeFirstAndHotspotsCount() {
        assertEquals("192.168.43.1", WorldEnvironment.pickLanAddress(interfaces("eth0", "203.0.113.5", "ap0", "192.168.43.1")));
        assertEquals("172.20.0.4", WorldEnvironment.pickLanAddress(interfaces("wlan0", "172.20.0.4")));
        assertEquals("203.0.113.5", WorldEnvironment.pickLanAddress(interfaces("wlan0", "203.0.113.5")));
        assertEquals("", WorldEnvironment.pickLanAddress(Collections.emptyList()));
    }
}
