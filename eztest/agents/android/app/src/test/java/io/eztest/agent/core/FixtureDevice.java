package io.eztest.agent.core;

import java.io.File;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * A Device over a fixture hierarchy (JVM tests): handles are the fixture's DOM
 * elements; a tap on an element with ez-alert opens an alert, typing appends to
 * text, check boxes toggle. Gestures and keys are recorded.
 */
public final class FixtureDevice implements Device {
    final Document doc;
    final List<List<List<long[]>>> gestures = new ArrayList<>();
    final List<String> keys = new ArrayList<>();
    String alert;
    String orientation = "portrait";

    public FixtureDevice(File fixture) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        this.doc = f.newDocumentBuilder().parse(fixture);
    }

    private void collect(Element e, List<Object> out, boolean root) {
        if (!root) out.add(e);
        for (Node c = e.getFirstChild(); c != null; c = c.getNextSibling()) if (c.getNodeType() == Node.ELEMENT_NODE) collect((Element) c, out, false);
    }

    @Override
    public Snapshot snapshot() throws Exception {
        StringWriter w = new StringWriter();
        javax.xml.transform.Transformer t = TransformerFactory.newInstance().newTransformer();
        t.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "no");
        t.transform(new DOMSource(doc), new StreamResult(w));
        List<Object> handles = new ArrayList<>();
        collect(doc.getDocumentElement(), handles, true);
        return new Snapshot(w.toString(), handles);
    }

    private static Element el(Object h) {
        Element e = (Element) h;
        if (e.getParentNode() == null) throw AgentError.stale("fixture element");
        return e;
    }

    private Element byId(String id) {
        List<Object> all = new ArrayList<>();
        collect(doc.getDocumentElement(), all, true);
        for (Object o : all) if (((Element) o).getAttribute("resource-id").endsWith(":id/" + id)) return (Element) o;
        return null;
    }

    @Override public void click(Object h) {
        Element e = el(h);
        if (!e.getAttribute("ez-alert").isEmpty()) {
            Element u = byId("username");
            alert = e.getAttribute("ez-alert").replace("{username}", u == null ? "" : u.getAttribute("text"));
        }
        if ("true".equals(e.getAttribute("checkable"))) e.setAttribute("checked", "true".equals(e.getAttribute("checked")) ? "false" : "true");
    }
    @Override public void clear(Object h) { el(h).setAttribute("text", ""); }
    @Override public void type(Object h, String text) { Element e = el(h); e.setAttribute("text", e.getAttribute("text") + text); }
    @Override public String text(Object h) { return el(h).getAttribute("text"); }
    @Override public String attribute(Object h, String name) { Element e = el(h); return e.hasAttribute(name) ? e.getAttribute(name) : null; }
    @Override public int[] rect(Object h) {
        String b = el(h).getAttribute("bounds");
        String[] p = b.replace("][", ",").replace("[", "").replace("]", "").split(",");
        int x1 = Integer.parseInt(p[0]), y1 = Integer.parseInt(p[1]), x2 = Integer.parseInt(p[2]), y2 = Integer.parseInt(p[3]);
        return new int[] { x1, y1, x2 - x1, y2 - y1 };
    }
    @Override public boolean displayed(Object h) { return !"false".equals(el(h).getAttribute("displayed")) && !"true".equals(el(h).getAttribute("ez-hidden")); }
    @Override public boolean enabled(Object h) { return !"false".equals(el(h).getAttribute("enabled")); }
    @Override public boolean selected(Object h) { return "true".equals(el(h).getAttribute("selected")) || "true".equals(el(h).getAttribute("checked")); }
    @Override public byte[] screenshotPng() { return Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="); }
    @Override public int[] window() {
        Element r = doc.getDocumentElement();
        return new int[] { 0, 0, Integer.parseInt(r.getAttribute("width")), Integer.parseInt(r.getAttribute("height")) };
    }
    @Override public void gesture(List<List<long[]>> fingers) { gestures.add(fingers); }
    @Override public void key(String key) { keys.add(key); }
    @Override public void keys(String text) { keys.add("text:" + text); }
    @Override public String orientation() { return orientation; }
    @Override public void setOrientation(String value) { orientation = value; }
    @Override public String alertText() { return alert; }
    @Override public void acceptAlert() { alert = null; }
    @Override public void dismissAlert() { alert = null; }
    @Override public void hideKeyboard() { }
    @Override public void app(String op, String appId) { keys.add("app:" + op + ":" + appId); }
    @Override public void background(double seconds) { keys.add("background:" + seconds); }
    @Override public void deepLink(String url, String appId) { keys.add("deeplink:" + url); }
    @Override public void openNotifications() { keys.add("notifications"); }
    @Override public void lock(Double seconds) { keys.add("lock"); }
    @Override public void unlock() { keys.add("unlock"); }
    @Override public void geolocation(double latitude, double longitude) { throw AgentError.notSupported("setting the location"); }
    @Override public void shake() { throw AgentError.notSupported("shaking the device"); }
    @Override public Map<String, Object> info() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("model", "JVM fixture");
        m.put("sdk", 34);
        return m;
    }
}
