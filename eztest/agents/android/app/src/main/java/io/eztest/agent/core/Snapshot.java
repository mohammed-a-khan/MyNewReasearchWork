package io.eztest.agent.core;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

/**
 * One UI hierarchy: the XML served at GET /source and the device handle of
 * every element (document order, the root &lt;hierarchy&gt; excluded), so
 * finders can run XPath over the DOM and map matches back to handles.
 */
public final class Snapshot {
    public final String xml;
    public final Document doc;
    /** Element nodes in document order (root excluded). */
    public final List<Element> elements = new ArrayList<>();
    public final List<Object> handles;

    public Snapshot(String xml, List<Object> handles) throws Exception {
        this.xml = xml;
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(false);
        f.setExpandEntityReferences(false);
        try {
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        } catch (Exception ignored) {
            // Not every platform parser knows the feature; the hierarchy XML never has a DOCTYPE anyway.
        }
        this.doc = f.newDocumentBuilder().parse(new InputSource(new StringReader(xml)));
        collect(doc.getDocumentElement(), true);
        this.handles = handles;
        if (handles.size() != elements.size()) throw new IllegalStateException("snapshot has " + elements.size() + " elements but " + handles.size() + " handles");
    }

    private void collect(Element e, boolean root) {
        if (!root) elements.add(e);
        for (Node c = e.getFirstChild(); c != null; c = c.getNextSibling()) {
            if (c.getNodeType() == Node.ELEMENT_NODE) collect((Element) c, false);
        }
    }

    public Object handleOf(Element e) {
        int i = elements.indexOf(e);
        return i < 0 ? null : handles.get(i);
    }

    /** Escape an attribute value for the hierarchy XML. */
    public static String attr(String v) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '&': b.append("&amp;"); break;
                case '<': b.append("&lt;"); break;
                case '>': b.append("&gt;"); break;
                case '"': b.append("&quot;"); break;
                case '\n': b.append("&#10;"); break;
                default:
                    if (c < 0x20 && c != '\t') b.append(' ');
                    else b.append(c);
            }
        }
        return b.toString();
    }

    /** A class name usable as an XML tag (inner classes and odd names sanitized). */
    public static String tag(String className) {
        if (className == null || className.isEmpty()) return "android.view.View";
        String t = className.replaceAll("[^A-Za-z0-9_.-]", "_");
        return Character.isLetter(t.charAt(0)) || t.charAt(0) == '_' ? t : "_" + t;
    }
}
