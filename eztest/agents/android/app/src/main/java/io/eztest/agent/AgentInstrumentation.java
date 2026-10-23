package io.eztest.agent;

import android.app.Instrumentation;
import android.os.Bundle;
import android.util.Log;
import io.eztest.agent.core.HttpServer;
import io.eztest.agent.core.Router;

/**
 * Entry point: `adb shell am instrument -w -e port 6790 io.eztest.agent/.AgentInstrumentation`.
 * Serves the EZTest agent protocol on 127.0.0.1:<port> (device loopback) until
 * POST /shutdown or the instrumentation is killed. EZTest reaches it with
 * `adb forward tcp:<local> tcp:<port>`.
 */
public class AgentInstrumentation extends Instrumentation {
    private static final String TAG = "EZTestAgent";
    private int port = 6790;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        if (arguments != null && arguments.getString("port") != null) port = Integer.parseInt(arguments.getString("port"));
        start();
    }

    @Override
    public void onStart() {
        super.onStart();
        Bundle status = new Bundle();
        try {
            UiAutomatorDevice device = new UiAutomatorDevice(this);
            Router router = new Router(device, "eztest-android");
            HttpServer server = new HttpServer(router, port);
            status.putString("eztest", "listening on 127.0.0.1:" + server.port());
            sendStatus(1, status);
            Log.i(TAG, "EZTest agent " + Router.VERSION + " listening on 127.0.0.1:" + server.port());
            server.serve();
            Bundle done = new Bundle();
            done.putString("eztest", "stopped");
            finish(0, done);
        } catch (Throwable t) {
            Log.e(TAG, "EZTest agent failed", t);
            Bundle err = new Bundle();
            err.putString("eztest", "failed: " + t);
            finish(1, err);
        }
    }
}
