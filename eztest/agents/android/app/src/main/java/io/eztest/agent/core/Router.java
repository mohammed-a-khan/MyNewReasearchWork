package io.eztest.agent.core;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.w3c.dom.Element;

/**
 * The EZTest agent protocol (version 1): routes HTTP requests to a Device.
 * Responses are JSON: { "value": ... } on success, { "error": { code, message } }
 * with a 4xx/5xx status on failure. See eztest docs/mobile.md, "Agent protocol".
 */
public final class Router {
    public static final String VERSION = "1.0.0";
    public static final int PROTOCOL = 1;

    public static final class Response {
        public final int status;
        public final String body;

        Response(int status, Object json) {
            this.status = status;
            this.body = Json.stringify(json);
        }
    }

    private final Device device;
    private final String agentName;
    /** Element ids handed out by /find (the most recent 1000 stay valid). */
    private final Map<String, Object> elements = new LinkedHashMap<String, Object>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Object> eldest) {
            return size() > 1000;
        }
    };
    private int nextId = 1;
    private volatile boolean shutdown;

    public Router(Device device, String agentName) {
        this.device = device;
        this.agentName = agentName;
    }

    public boolean isShutdown() {
        return shutdown;
    }

    private static Map<String, Object> value(Object v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("value", v);
        return m;
    }

    private static Response ok(Object v) {
        return new Response(200, value(v));
    }

    private static Response error(int status, String code, String message) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("code", code);
        e.put("message", message);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", e);
        return new Response(status, m);
    }

    private Object handle(String id) {
        Object h = elements.get(id);
        if (h == null) throw AgentError.stale(id);
        return h;
    }

    private static String str(Map<String, Object> body, String key) {
        Object v = body.get(key);
        if (!(v instanceof String)) throw AgentError.invalid("\"" + key + "\" must be a string");
        return (String) v;
    }

    private static double num(Map<String, Object> body, String key) {
        Object v = body.get(key);
        if (!(v instanceof Number)) throw AgentError.invalid("\"" + key + "\" must be a number");
        return ((Number) v).doubleValue();
    }

    private static Map<String, Object> rect(int[] r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("x", r[0]);
        m.put("y", r[1]);
        m.put("width", r[2]);
        m.put("height", r[3]);
        return m;
    }

    @SuppressWarnings("unchecked")
    static List<List<long[]>> fingers(Map<String, Object> body) {
        Object f = body.get("fingers");
        if (!(f instanceof List) || ((List<Object>) f).isEmpty()) throw AgentError.invalid("gesture needs \"fingers\": [[{x, y, t}, ...], ...]");
        List<List<long[]>> out = new ArrayList<>();
        for (Object finger : (List<Object>) f) {
            if (!(finger instanceof List) || ((List<Object>) finger).size() < 2) throw AgentError.invalid("each finger needs at least two points");
            List<long[]> pts = new ArrayList<>();
            long lastT = -1;
            for (Object p : (List<Object>) finger) {
                Map<String, Object> pt = (Map<String, Object>) p;
                long t = Math.round(num(pt, "t"));
                if (t < lastT) throw AgentError.invalid("gesture times must not go backwards");
                lastT = t;
                pts.add(new long[] { Math.round(num(pt, "x")), Math.round(num(pt, "y")), t });
            }
            out.add(pts);
        }
        return out;
    }

    /** Handle one request. Never throws. */
    @SuppressWarnings("unchecked")
    public synchronized Response handle(String method, String path, String rawBody) {
        try {
            Object parsed = Json.parse(rawBody);
            Map<String, Object> body = parsed instanceof Map ? (Map<String, Object>) parsed : new HashMap<String, Object>();
            String route = method + " " + path;
            if (path.startsWith("/element/")) return element(method, path.substring("/element/".length()), body);
            switch (route) {
                case "GET /status": {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("ready", true);
                    m.put("agent", agentName);
                    m.put("version", VERSION);
                    m.put("protocol", PROTOCOL);
                    m.put("platform", "android");
                    m.put("device", device.info());
                    return new Response(200, m);
                }
                case "POST /find": {
                    Snapshot snap = device.snapshot();
                    List<Object> ids = new ArrayList<>();
                    for (Element e : Finder.find(snap, str(body, "using"), str(body, "value"))) {
                        String id = "e" + (nextId++);
                        elements.put(id, snap.handleOf(e));
                        ids.add(id);
                    }
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("elements", ids);
                    return new Response(200, m);
                }
                case "GET /source": return ok(device.snapshot().xml);
                case "GET /screenshot": return ok(Base64.getEncoder().encodeToString(device.screenshotPng()));
                case "GET /window": return ok(rect(device.window()));
                case "POST /gesture": device.gesture(fingers(body)); return ok(null);
                case "POST /key": device.key(str(body, "key")); return ok(null);
                case "POST /keys": device.keys(str(body, "text")); return ok(null);
                case "GET /orientation": return ok(device.orientation());
                case "POST /orientation": {
                    String v = str(body, "value");
                    if (!v.equals("portrait") && !v.equals("landscape")) throw AgentError.invalid("orientation must be portrait or landscape");
                    device.setOrientation(v);
                    return ok(null);
                }
                case "GET /alert": return ok(device.alertText());
                case "POST /alert/accept":
                case "POST /alert/dismiss": {
                    if (device.alertText() == null) return error(404, "no such alert", "no alert is open");
                    if (path.endsWith("accept")) device.acceptAlert();
                    else device.dismissAlert();
                    return ok(null);
                }
                case "POST /keyboard/hide": device.hideKeyboard(); return ok(null);
                case "POST /app/launch":
                case "POST /app/activate":
                case "POST /app/terminate": device.app(path.substring("/app/".length()), str(body, "appId")); return ok(null);
                case "POST /app/background": device.background(num(body, "seconds")); return ok(null);
                case "POST /deeplink": device.deepLink(str(body, "url"), body.get("appId") instanceof String ? (String) body.get("appId") : null); return ok(null);
                case "POST /notifications/open": device.openNotifications(); return ok(null);
                case "POST /lock": device.lock(body.get("seconds") instanceof Number ? ((Number) body.get("seconds")).doubleValue() : null); return ok(null);
                case "POST /unlock": device.unlock(); return ok(null);
                case "POST /geolocation": device.geolocation(num(body, "latitude"), num(body, "longitude")); return ok(null);
                case "POST /shake": device.shake(); return ok(null);
                case "POST /shutdown": shutdown = true; return ok(null);
                default: return error(404, "unknown command", route);
            }
        } catch (AgentError e) {
            return error(e.status, e.code, e.getMessage());
        } catch (IllegalArgumentException e) {
            return error(400, "invalid argument", String.valueOf(e.getMessage()));
        } catch (Exception e) {
            return error(500, "internal", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private Response element(String method, String rest, Map<String, Object> body) throws Exception {
        int slash = rest.indexOf('/');
        if (slash < 0) return error(404, "unknown command", method + " /element/" + rest);
        String id = rest.substring(0, slash);
        String op = rest.substring(slash + 1);
        Object h = handle(id);
        if (method.equals("POST")) {
            switch (op) {
                case "click": device.click(h); return ok(null);
                case "clear": device.clear(h); return ok(null);
                case "type": device.type(h, str(body, "text")); return ok(null);
                default: return error(404, "unknown command", "POST /element/:id/" + op);
            }
        }
        if (op.startsWith("attribute/")) return ok(device.attribute(h, java.net.URLDecoder.decode(op.substring("attribute/".length()), "UTF-8")));
        switch (op) {
            case "text": return ok(device.text(h));
            case "rect": return ok(rect(device.rect(h)));
            case "displayed": return ok(device.displayed(h));
            case "enabled": return ok(device.enabled(h));
            case "selected": return ok(device.selected(h));
            default: return error(404, "unknown command", "GET /element/:id/" + op);
        }
    }
}
