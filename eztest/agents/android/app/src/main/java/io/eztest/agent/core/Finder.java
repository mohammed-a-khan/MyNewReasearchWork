package io.eztest.agent.core;

import java.util.ArrayList;
import java.util.List;
import javax.xml.namespace.QName;
import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathConstants;
import javax.xml.xpath.XPathExpressionException;
import javax.xml.xpath.XPathFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Element finding over a hierarchy snapshot. Every strategy is XPath over the
 * hierarchy XML; values are bound as XPath variables ($v), never spliced into
 * the expression, so a text like  a" or "1"="1  cannot change the query.
 *
 * Strategies: id (resource-id, exact or the part after ":id/"),
 * accessibility id (content-desc), text, text contains, class, xpath.
 */
public final class Finder {
    private Finder() {}

    static String expressionFor(String using) {
        switch (using) {
            case "id": return "//*[@resource-id=$v or substring-after(@resource-id, ':id/')=$v]";
            case "accessibility id": return "//*[@content-desc=$v]";
            case "text": return "//*[@text=$v]";
            case "text contains": return "//*[contains(@text, $v)]";
            case "class": return "//*[local-name()=$v or @class=$v]";
            case "xpath": return null;
            case "predicate": throw AgentError.notSupported("NSPredicate (iOS only) strategy");
            case "css": throw AgentError.notSupported("CSS selectors (web views only)");
            default: throw AgentError.invalid("unknown find strategy \"" + using + "\"");
        }
    }

    /** Matching elements, in document order. */
    public static List<Element> find(Snapshot snap, String using, final String value) {
        String expr = expressionFor(using);
        XPath xp = XPathFactory.newInstance().newXPath();
        xp.setXPathVariableResolver((QName name) -> "v".equals(name.getLocalPart()) ? value : null);
        NodeList nodes;
        try {
            nodes = (NodeList) xp.evaluate(expr != null ? expr : value, snap.doc, XPathConstants.NODESET);
        } catch (XPathExpressionException e) {
            throw AgentError.invalid("invalid XPath " + (expr != null ? expr : value) + ": " + (e.getCause() != null ? e.getCause().getMessage() : e.getMessage()));
        }
        List<Element> out = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node n = nodes.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE && n != snap.doc.getDocumentElement()) out.add((Element) n);
        }
        return out;
    }
}
