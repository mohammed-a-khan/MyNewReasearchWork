package io.eztest.agent.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * A minimal HTTP/1.1 server for the agent protocol: one request per
 * connection, JSON bodies with Content-Length, loopback only (the host
 * reaches it through `adb forward` / usbmuxd, never over the network).
 *
 * Every request must carry the session token the agent was started with in
 * the X-EZTest-Agent-Token header; anything else is answered 401
 * "unauthorized" without reaching the router. An agent started without a
 * token answers nothing.
 */
public final class HttpServer {
    private static final int MAX_BODY = 8 * 1024 * 1024;
    static final String TOKEN_HEADER = "x-eztest-agent-token";

    private final Router router;
    private final ServerSocket socket;
    private final byte[] token;

    public HttpServer(Router router, int port, String token) throws IOException {
        this.router = router;
        this.token = token == null || token.isEmpty() ? null : token.getBytes(StandardCharsets.UTF_8);
        this.socket = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
    }

    /** Constant-time comparison of the presented token with the session token. */
    boolean authorized(String presented) {
        if (token == null || presented == null) return false;
        return MessageDigest.isEqual(token, presented.getBytes(StandardCharsets.UTF_8));
    }

    public int port() {
        return socket.getLocalPort();
    }

    /** Serve until POST /shutdown (or the socket is closed). */
    public void serve() throws IOException {
        while (!router.isShutdown() && !socket.isClosed()) {
            Socket client;
            try {
                client = socket.accept();
            } catch (IOException e) {
                if (socket.isClosed()) return;
                throw e;
            }
            try {
                handle(client);
            } catch (IOException ignored) {
                // A client that went away mid-request; keep serving.
            } finally {
                try { client.close(); } catch (IOException ignored) { /* closing */ }
            }
        }
        socket.close();
    }

    public void close() throws IOException {
        socket.close();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 16 * 1024) throw new IOException("header line too long");
        }
        return c == -1 && b.size() == 0 ? null : b.toString("UTF-8");
    }

    private void handle(Socket client) throws IOException {
        client.setSoTimeout(60_000);
        InputStream in = client.getInputStream();
        String requestLine = readLine(in);
        if (requestLine == null) return;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            write(client.getOutputStream(), new Router.Response(400, Json.parse("{\"error\":{\"code\":\"invalid argument\",\"message\":\"bad request line\"}}")));
            return;
        }
        int length = 0;
        String presented = null;
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String name = line.substring(0, colon).trim();
            if (name.equalsIgnoreCase("content-length")) length = Integer.parseInt(line.substring(colon + 1).trim());
            else if (name.equalsIgnoreCase(TOKEN_HEADER)) presented = line.substring(colon + 1).trim();
        }
        if (!authorized(presented)) {
            String why = token == null ? "the agent was started without a session token (-e token <secret>)" : "missing or wrong session token";
            write(client.getOutputStream(), new Router.Response(401, Json.parse("{\"error\":{\"code\":\"unauthorized\",\"message\":\"" + why + "\"}}")));
            return;
        }
        if (length < 0 || length > MAX_BODY) throw new IOException("body too large");
        byte[] body = new byte[length];
        int off = 0;
        while (off < length) {
            int n = in.read(body, off, length - off);
            if (n < 0) throw new IOException("body ended early");
            off += n;
        }
        String path = parts[1];
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        write(client.getOutputStream(), router.handle(parts[0], path, new String(body, StandardCharsets.UTF_8)));
    }

    private static void write(OutputStream out, Router.Response r) throws IOException {
        byte[] b = r.body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + r.status + " " + (r.status < 400 ? "OK" : "Error") + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(b);
        out.flush();
    }
}
