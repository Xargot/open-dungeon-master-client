package com.opendungeonmaster.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.Locale;

/**
 * The phone's own speech recognizer, for dictating into the game when the
 * server has no speech-to-text (above all the world this phone hosts).
 * mobile/src/dictation-core.ts turns it into window.odmDictation.
 *
 * A DM speaks a summary for minutes, with pauses, while Android's
 * recognizer ends a take at the first long silence. So one take here is a
 * run of recognizer sessions: each result is kept, the recognizer starts
 * again, and only stop() ends the run and hands back everything heard.
 * The on-device recognizer is preferred (offline, nothing leaves the
 * phone); the default one (often Google's, online) is the fallback.
 *
 * available() -> { available, onDevice }
 * start({ language? }) -> resolves once listening; asks for the microphone
 *                 first. language is the table's BCP 47 tag ("it"); the
 *                 phone's own language when unsaid or the same.
 * stop()      -> { text }
 * cancel()
 * events: level { level: 0..1 }, partial { text }, error { message }
 */
@CapacitorPlugin(
    name = "OdmDictation",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class DictationPlugin extends Plugin {

    // How long stop() waits for the recognizer's last result before it
    // answers with what it has.
    private static final long STOP_GRACE_MS = 2500;
    private static final long LEVEL_EVERY_MS = 60;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean onDevice;
    // The table's language when it is not the phone's own, else "": the
    // take asks for it (RecognizerIntent.EXTRA_LANGUAGE).
    private String language = "";
    // Every finished session's words, in order.
    private final StringBuilder heard = new StringBuilder();
    // The session in progress, as the recognizer currently hears it.
    private String partial = "";
    // True from start() until stop() or cancel(): sessions keep restarting.
    private boolean listening;
    private PluginCall pendingStop;
    private long lastLevelAt;
    private final Runnable stopGrace = this::finish;

    @PluginMethod
    public void available(PluginCall call) {
        Context context = getContext();
        boolean device = onDeviceAvailable(context);
        JSObject result = new JSObject();
        result.put("available", device || SpeechRecognizer.isRecognitionAvailable(context));
        result.put("onDevice", device);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneAnswered");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphoneAnswered(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("The microphone permission was refused. Allow it for Open Game Master in the phone's settings.");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            listening = false;
            if (recognizer == null) {
                resolveText(call);
                return;
            }
            pendingStop = call;
            recognizer.stopListening();
            main.postDelayed(stopGrace, STOP_GRACE_MS);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            listening = false;
            pendingStop = null;
            teardown();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::teardown);
        super.handleOnDestroy();
    }

    private static boolean onDeviceAvailable(Context context) {
        return Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
    }

    private void begin(PluginCall call) {
        main.post(() -> {
            teardown();
            heard.setLength(0);
            partial = "";
            pendingStop = null;
            Context context = getContext();
            onDevice = onDeviceAvailable(context);
            if (!onDevice && !SpeechRecognizer.isRecognitionAvailable(context)) {
                call.reject("This phone has no speech recognizer.");
                return;
            }
            language = wanted(call.getString("language", ""));
            listening = true;
            listen();
            call.resolve();
        });
    }

    // The table's language, unless it is the phone's own: a phone set to
    // British English keeps its "en-GB" at an English table rather than being
    // told plain "en". Norwegian is one language here whichever written form
    // the phone or the table names.
    private static String wanted(String tag) {
        String asked = tag == null ? "" : tag.trim();
        if (asked.isEmpty()) {
            return "";
        }
        String table = norwegian(Locale.forLanguageTag(asked).getLanguage());
        String own = norwegian(Locale.getDefault().getLanguage());
        return table.isEmpty() || table.equals(own) ? "" : asked;
    }

    private static String norwegian(String code) {
        return "no".equals(code) || "nn".equals(code) ? "nb" : code;
    }

    private void listen() {
        if (recognizer == null) {
            Context context = getContext();
            recognizer = onDevice && Build.VERSION.SDK_INT >= 31
                ? SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                : SpeechRecognizer.createSpeechRecognizer(context);
            recognizer.setRecognitionListener(listener);
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        if (!language.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        }
        // A DM pauses to think; ask for patience (not every recognizer
        // honours it, which is why sessions restart below).
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 5000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 5000L);
        recognizer.startListening(intent);
    }

    private String everything() {
        String done = heard.toString().trim();
        String now = partial.trim();
        if (now.isEmpty()) {
            return done;
        }
        return done.isEmpty() ? now : done + " " + now;
    }

    private void keep(String words) {
        String trimmed = words == null ? "" : words.trim();
        if (trimmed.isEmpty()) {
            return;
        }
        if (heard.length() > 0) {
            heard.append(' ');
        }
        heard.append(trimmed);
    }

    private void resolveText(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", everything());
        call.resolve(result);
    }

    // The run is over: answer stop() with everything heard.
    private void finish() {
        main.removeCallbacks(stopGrace);
        PluginCall call = pendingStop;
        pendingStop = null;
        if (call != null) {
            resolveText(call);
        }
        teardown();
    }

    private void teardown() {
        main.removeCallbacks(stopGrace);
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    private void emitPartial() {
        JSObject event = new JSObject();
        event.put("text", everything());
        notifyListeners("partial", event);
    }

    private static String best(Bundle results) {
        if (results == null) {
            return "";
        }
        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0);
    }

    private static String errorText(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "The phone's speech recognizer needs the internet and could not reach it.";
            case SpeechRecognizer.ERROR_AUDIO:
                return "The microphone stopped (another app may be using it).";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "The microphone permission was refused. Allow it for Open Game Master in the phone's settings.";
            default:
                return "The phone's speech recognizer stopped (error " + code + ").";
        }
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {
            long now = System.currentTimeMillis();
            if (now - lastLevelAt < LEVEL_EVERY_MS) {
                return;
            }
            lastLevelAt = now;
            // Roughly -2 dB in a quiet room to 10 dB for a raised voice.
            float level = Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f));
            JSObject event = new JSObject();
            event.put("level", level);
            notifyListeners("level", event);
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onPartialResults(Bundle partialResults) {
            String words = best(partialResults);
            if (!words.isEmpty()) {
                partial = words;
                emitPartial();
            }
        }

        @Override
        public void onResults(Bundle results) {
            String words = best(results);
            keep(words.isEmpty() ? partial : words);
            partial = "";
            emitPartial();
            if (listening) {
                listen();
            } else {
                finish();
            }
        }

        @Override
        public void onError(int error) {
            // A pause long enough to end the session is not the end of the
            // take: keep what the session heard and listen again.
            boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (!listening) {
                keep(partial);
                partial = "";
                finish();
                return;
            }
            if (quiet) {
                keep(partial);
                partial = "";
                listen();
                return;
            }
            if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_CLIENT) {
                main.postDelayed(() -> {
                    if (listening) {
                        teardown();
                        listen();
                    }
                }, 250);
                return;
            }
            // The on-device recognizer may lack this language's pack: fall
            // back to the default recognizer once, mid-take.
            boolean languageMissing = Build.VERSION.SDK_INT >= 31
                && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE);
            if (languageMissing && onDevice && SpeechRecognizer.isRecognitionAvailable(getContext())) {
                onDevice = false;
                teardown();
                listen();
                return;
            }
            // Neither recognizer knows the table's language: hear the
            // phone's own rather than nothing, as a take did before the
            // table's language was asked for.
            if (languageMissing && !language.isEmpty()) {
                language = "";
                teardown();
                listen();
                return;
            }
            keep(partial);
            partial = "";
            listening = false;
            teardown();
            JSObject event = new JSObject();
            event.put("message", errorText(error));
            notifyListeners("error", event);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    };
}
