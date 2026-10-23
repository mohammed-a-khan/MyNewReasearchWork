package io.eztest.agent.core;

import java.io.File;
import java.util.List;
import java.util.Map;

/**
 * JVM checks of the agent's request handling (no Android needed): routes,
 * finders, error mapping, argument validation, JSON. Run with
 * `java io.eztest.agent.core.AgentCoreChecks <fixture.xml>`; exits non-zero on
 * the first failure. AgentCoreTest runs the same checks under JUnit (Gradle).
 */
public final class AgentCoreChecks {
    private static int checks;

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError("FAILED: " + what);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> json(Router.Response r) {
        return (Map<String, Object>) Json.parse(r.body);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> ids(Router.Response r) {
        return (List<Object>) json(r).get("elements");
    }

    private static String code(Router.Response r) {
        @SuppressWarnings("unchecked")
        Map<String, Object> e = (Map<String, Object>) json(r).get("error");
        return e == null ? null : (String) e.get("code");
    }

    public static int run(File fixture) throws Exception {
        checks = 0;
        FixtureDevice d = new FixtureDevice(fixture);
        Router r = new Router(d, "eztest-android");

        Router.Response status = r.handle("GET", "/status", "");
        check(status.status == 200 && Boolean.TRUE.equals(json(status).get("ready")) && "android".equals(json(status).get("platform")), "status");

        check(ids(r.handle("POST", "/find", "{\"using\":\"id\",\"value\":\"loginBtn\"}")).size() == 1, "find by short resource id");
        check(ids(r.handle("POST", "/find", "{\"using\":\"id\",\"value\":\"com.shop.app:id/loginBtn\"}")).size() == 1, "find by full resource id");
        check(ids(r.handle("POST", "/find", "{\"using\":\"accessibility id\",\"value\":\"Username\"}")).size() == 1, "find by content-desc");
        check(ids(r.handle("POST", "/find", "{\"using\":\"text\",\"value\":\"Log in\"}")).size() == 1, "find by text");
        check(ids(r.handle("POST", "/find", "{\"using\":\"text contains\",\"value\":\"ORD-\"}")).size() == 2, "find by text contains");
        check(ids(r.handle("POST", "/find", "{\"using\":\"class\",\"value\":\"android.widget.Button\"}")).size() == 3, "find by class");
        check(ids(r.handle("POST", "/find", "{\"using\":\"xpath\",\"value\":\"//*[(contains(local-name(),'Button') or @clickable='true') and (@text='Log in')]\"}")).size() == 1, "find by xpath");
        // Values are bound as XPath variables: quotes cannot break out of the query.
        check(ids(r.handle("POST", "/find", "{\"using\":\"text\",\"value\":\"x' or '1'='1\"}")).isEmpty(), "text values cannot inject XPath");
        check("invalid argument".equals(code(r.handle("POST", "/find", "{\"using\":\"xpath\",\"value\":\"//[\"}"))), "invalid xpath is an invalid argument");
        check("not supported".equals(code(r.handle("POST", "/find", "{\"using\":\"predicate\",\"value\":\"label == 'x'\"}"))), "predicate is iOS only");
        check("invalid argument".equals(code(r.handle("POST", "/find", "{\"using\":\"nope\",\"value\":\"x\"}"))), "unknown strategy");

        String user = (String) ids(r.handle("POST", "/find", "{\"using\":\"id\",\"value\":\"username\"}")).get(0);
        check(r.handle("POST", "/element/" + user + "/type", "{\"text\":\"alice\"}").status == 200, "type");
        check("alice".equals(json(r.handle("GET", "/element/" + user + "/text", "")).get("value")), "text after typing");
        check("Username".equals(json(r.handle("GET", "/element/" + user + "/attribute/hint", "")).get("value")), "attribute");
        check(json(r.handle("GET", "/element/" + user + "/attribute/nope", "")).get("value") == null, "missing attribute is null");
        @SuppressWarnings("unchecked")
        Map<String, Object> rect = (Map<String, Object>) json(r.handle("GET", "/element/" + user + "/rect", "")).get("value");
        check(((Number) rect.get("x")).intValue() == 40 && ((Number) rect.get("height")).intValue() == 120, "rect");

        String login = (String) ids(r.handle("POST", "/find", "{\"using\":\"id\",\"value\":\"loginBtn\"}")).get(0);
        check("no such alert".equals(code(r.handle("POST", "/alert/accept", "{}"))), "no alert yet");
        r.handle("POST", "/element/" + login + "/click", "{}");
        check("Signed in as alice".equals(json(r.handle("GET", "/alert", "")).get("value")), "tap opened the alert");
        check(r.handle("POST", "/alert/accept", "{}").status == 200 && d.alert == null, "accept the alert");
        // Earlier element ids stay valid after later finds.
        check("alice".equals(json(r.handle("GET", "/element/" + user + "/text", "")).get("value")), "ids survive later finds");
        check("stale element".equals(code(r.handle("POST", "/element/e999/click", "{}"))), "unknown id is stale");

        check(r.handle("POST", "/gesture", "{\"fingers\":[[{\"x\":1,\"y\":2,\"t\":0},{\"x\":1,\"y\":2,\"t\":50}],[{\"x\":5,\"y\":5,\"t\":0},{\"x\":9,\"y\":9,\"t\":500}]]}").status == 200, "gesture");
        check(d.gestures.size() == 1 && d.gestures.get(0).size() == 2 && d.gestures.get(0).get(1).get(1)[2] == 500, "gesture parsed into finger paths");
        check("invalid argument".equals(code(r.handle("POST", "/gesture", "{\"fingers\":[[{\"x\":1,\"y\":2,\"t\":50},{\"x\":1,\"y\":2,\"t\":0}]]}"))), "times must not go backwards");
        check("invalid argument".equals(code(r.handle("POST", "/gesture", "{\"fingers\":[]}"))), "gesture needs fingers");
        check(r.handle("POST", "/key", "{\"key\":\"back\"}").status == 200 && d.keys.contains("back"), "key");
        check(r.handle("POST", "/orientation", "{\"value\":\"landscape\"}").status == 200 && "landscape".equals(json(r.handle("GET", "/orientation", "")).get("value")), "orientation");
        check("invalid argument".equals(code(r.handle("POST", "/orientation", "{\"value\":\"sideways\"}"))), "bad orientation");
        check(r.handle("POST", "/app/launch", "{\"appId\":\"com.shop.app\"}").status == 200 && d.keys.contains("app:launch:com.shop.app"), "app launch");
        check("invalid argument".equals(code(r.handle("POST", "/app/launch", "{}"))), "app needs appId");
        check(r.handle("POST", "/deeplink", "{\"url\":\"shop://x\"}").status == 200, "deeplink");
        check("not supported".equals(code(r.handle("POST", "/geolocation", "{\"latitude\":1,\"longitude\":2}"))), "unsupported operation");
        check("unknown command".equals(code(r.handle("GET", "/nope", ""))), "unknown route");
        check("invalid argument".equals(code(r.handle("POST", "/find", "{bad json"))), "bad JSON");
        check(((String) json(r.handle("GET", "/source", "")).get("value")).contains("android.widget.EditText"), "source");
        check(((String) json(r.handle("GET", "/screenshot", "")).get("value")).startsWith("iVBOR"), "screenshot");

        Object round = Json.parse(Json.stringify(Json.parse("{\"a\":[1,2.5,\"x\\\"y\\n\",true,null,{\"b\":\"\\u00e9\"}]}")));
        check(Json.stringify(round).equals("{\"a\":[1,2.5,\"x\\\"y\\n\",true,null,{\"b\":\"é\"}]}"), "JSON round trip");

        check(r.handle("POST", "/shutdown", "{}").status == 200 && r.isShutdown(), "shutdown");
        return checks;
    }

    public static void main(String[] args) throws Exception {
        int n = run(new File(args[0]));
        System.out.println("AGENT_CORE_CHECKS_PASSED " + n);
    }
}
