package dev.eztest.agent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * EZTest's Java desktop agent (protocol ez-agent/1). Loaded with
 * {@code -javaagent:ez-java-agent.jar=port=0,token=SECRET,portFile=/tmp/x}, it
 * serves {@code POST /v1/rpc} on 127.0.0.1 and walks the Swing/AWT component
 * tree in-process. No third-party automation tool or library is used.
 */
public final class EzAgent {
    static final String PROTOCOL = "ez-agent/1";
    static final String VERSION = "0.1.0";

    private EzAgent() {}

    public static void premain(String args, Instrumentation inst) throws IOException {
        start(args);
    }

    public static void agentmain(String args, Instrumentation inst) throws IOException {
        start(args);
    }

    static Map<String, String> options(String args) {
        Map<String, String> o = new LinkedHashMap<>();
        if (args == null) return o;
        for (String part : args.split(",")) {
            int eq = part.indexOf('=');
            if (eq > 0) o.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
        }
        return o;
    }

    static void start(String args) throws IOException {
        Map<String, String> o = options(args);
        String host = o.getOrDefault("host", "127.0.0.1");
        int port = Integer.parseInt(o.getOrDefault("port", "0"));
        String token = o.getOrDefault("token", System.getenv("EZ_AGENT_TOKEN"));
        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 16);
        SwingModel model = new SwingModel();
        server.createContext("/v1/rpc", ex -> handle(ex, token, model));
        server.setExecutor(Executors.newFixedThreadPool(4, r -> {
            Thread t = new Thread(r, "ez-agent");
            t.setDaemon(true);
            return t;
        }));
        server.start();
        int actual = server.getAddress().getPort();
        String portFile = o.get("portFile");
        if (portFile != null) {
            Path tmp = Path.of(portFile + ".tmp");
            Files.writeString(tmp, String.valueOf(actual));
            Files.move(tmp, Path.of(portFile), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        }
        System.err.println("ez-java-agent listening on http://" + host + ":" + actual);
    }

    private static boolean tokenOk(String expected, String got) {
        if (expected == null || expected.isEmpty()) return true;
        if (got == null) return false;
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), got.getBytes(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    private static void handle(HttpExchange ex, String token, SwingModel model) throws IOException {
        Map<String, Object> out = new LinkedHashMap<>();
        int status = 200;
        try {
            if (!"POST".equals(ex.getRequestMethod())) {
                status = 405;
                out.put("ok", false);
                out.put("error", error("method", "use POST"));
            } else if (!tokenOk(token, ex.getRequestHeaders().getFirst("x-ez-agent-token"))) {
                status = 401;
                out.put("ok", false);
                out.put("error", error("unauthorized", "missing or wrong X-EZ-Agent-Token"));
            } else {
                Object req = Json.parse(readAll(ex.getRequestBody()));
                if (!(req instanceof Map)) throw new AgentException("protocol", "request must be a JSON object");
                Map<String, Object> m = (Map<String, Object>) req;
                String method = String.valueOf(m.get("method"));
                Map<String, Object> params = m.get("params") instanceof Map ? (Map<String, Object>) m.get("params") : new LinkedHashMap<>();
                out.put("ok", true);
                out.put("result", model.call(method, params));
            }
        } catch (AgentException e) {
            out.clear();
            out.put("ok", false);
            out.put("error", error(e.code, e.getMessage()));
        } catch (Throwable e) {
            out.clear();
            out.put("ok", false);
            out.put("error", error("error", e.getClass().getSimpleName() + ": " + e.getMessage()));
        }
        byte[] body = Json.write(out).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("content-type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("code", code);
        e.put("message", message);
        return e;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            b.write(buf, 0, n);
            if (b.size() > 8 * 1024 * 1024) throw new IOException("request too large");
        }
        return b.toString(StandardCharsets.UTF_8);
    }
}

final class AgentException extends RuntimeException {
    final String code;

    AgentException(String code, String message) {
        super(message);
        this.code = code;
    }
}
