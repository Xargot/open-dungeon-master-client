package com.opendungeonmaster.app;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Edge to edge on every Android version, not only the 15+ ones that
        // enforce it: the window draws behind transparent system bars with
        // light icons on them (the app is night-only), and Capacitor's
        // adjustMarginsForEdgeToEdge keeps the page between the bars, so what
        // shows through them is the window background, the same night color
        // as the page. This is the replacement for the statusBarColor and
        // navigationBarColor theme attributes Android 15 deprecated, and it
        // has to run before the bridge sets the content view.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        // The phone-hosted world plugin, the streaming download plugin and
        // the speech recognizer live in this app rather than a package, so
        // they register here before the bridge loads the page.
        registerPlugin(LocalWorldPlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(DictationPlugin.class);
        registerPlugin(SecretStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
