package dev.eztest.agent;

import javax.accessibility.AccessibleContext;
import javax.imageio.ImageIO;
import javax.swing.AbstractButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JEditorPane;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPasswordField;
import javax.swing.JPopupMenu;
import javax.swing.JProgressBar;
import javax.swing.JRadioButton;
import javax.swing.JScrollBar;
import javax.swing.JSlider;
import javax.swing.JSpinner;
import javax.swing.JTabbedPane;
import javax.swing.JTable;
import javax.swing.JTextArea;
import javax.swing.JToggleButton;
import javax.swing.JToolBar;
import javax.swing.JTree;
import javax.swing.MenuSelectionManager;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;
import javax.swing.tree.TreeModel;
import javax.swing.tree.TreePath;
import java.awt.Component;
import java.awt.Container;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.KeyboardFocusManager;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.InputEvent;
import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import java.awt.event.WindowEvent;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The Swing/AWT side of the agent: element registry, tree walk (reported with
 * UI Automation control type names) and the actions of protocol ez-agent/1.
 * Reads run on the event dispatch thread with invokeAndWait; actions are
 * posted with invokeLater (a modal dialog opened by a click must not block
 * the request) and then synchronised with an empty invokeAndWait.
 */
final class SwingModel {
    private final Map<String, WeakReference<Component>> byId = new HashMap<>();
    private final Map<Component, String> ids = new WeakHashMap<>();
    private final AtomicInteger seq = new AtomicInteger();
    private static final int MAX_ELEMENTS = 5000;
    /** Components already reported in this walk (an open popup menu is reachable twice). */
    private final java.util.Set<Component> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());

    // ------------------------------------------------------------------ EDT helpers

    private static <T> T edt(Callable<T> c) {
        if (SwingUtilities.isEventDispatchThread()) {
            try {
                return c.call();
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        Object[] box = new Object[1];
        Throwable[] err = new Throwable[1];
        try {
            SwingUtilities.invokeAndWait(() -> {
                try {
                    box[0] = c.call();
                } catch (Throwable t) {
                    err[0] = t;
                }
            });
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AgentException("interrupted", "interrupted");
        } catch (InvocationTargetException e) {
            throw new RuntimeException(e.getCause());
        }
        if (err[0] instanceof RuntimeException) throw (RuntimeException) err[0];
        if (err[0] != null) throw new RuntimeException(err[0]);
        @SuppressWarnings("unchecked") T t = (T) box[0];
        return t;
    }

    /** Post an action, then wait until the event queue has processed it (modal dialogs keep pumping events). */
    private static void act(Runnable r) {
        SwingUtilities.invokeLater(r);
        edt(() -> null);
        edt(() -> null);
    }

    // ------------------------------------------------------------------ ids

    private String idOf(Component c) {
        String id = ids.get(c);
        if (id == null) {
            id = "c" + seq.incrementAndGet();
            ids.put(c, id);
            byId.put(id, new WeakReference<>(c));
        }
        return id;
    }

    private Component comp(Object id) {
        String s = String.valueOf(id);
        int tab = s.indexOf(":tab:");
        if (tab > 0) s = s.substring(0, tab);
        WeakReference<Component> r = byId.get(s);
        Component c = r == null ? null : r.get();
        if (c == null) throw new AgentException("stale", "element " + id + " no longer exists (refresh the elements)");
        return c;
    }

    private static int tabIndex(Object id) {
        String s = String.valueOf(id);
        int tab = s.indexOf(":tab:");
        return tab > 0 ? Integer.parseInt(s.substring(tab + 5)) : -1;
    }

    private Window window(Object id) {
        Component c = comp(id);
        if (!(c instanceof Window)) throw new AgentException("no-window", id + " is not a window");
        return (Window) c;
    }

    // ------------------------------------------------------------------ dispatch

    Object call(String method, Map<String, Object> p) {
        switch (method) {
            case "hello": {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("agent", "java");
                m.put("protocol", EzAgent.PROTOCOL);
                m.put("version", EzAgent.VERSION);
                m.put("platform", "Java " + System.getProperty("java.version") + " on " + System.getProperty("os.name"));
                return m;
            }
            case "windows": return Map.of("windows", edt(this::windows));
            case "elements": return edt(() -> elements(window(p.get("window"))));
            case "activate": act(() -> { Window w = window(p.get("window")); w.toFront(); w.requestFocus(); }); return Map.of();
            case "closeWindow": {
                Window w = window(p.get("window"));
                act(() -> w.dispatchEvent(new WindowEvent(w, WindowEvent.WINDOW_CLOSING)));
                return Map.of();
            }
            case "invoke": invoke(p.get("id")); return Map.of();
            case "setValue": setValue(p.get("id"), String.valueOf(p.get("value"))); return Map.of();
            case "getValue": {
                String v = edt(() -> value(comp(p.get("id")), true));
                return Map.of("value", v == null ? "" : v);
            }
            case "toggle": toggle(p.get("id"), (String) p.get("state")); return Map.of();
            case "expand": expand(p.get("id"), true); return Map.of();
            case "collapse": expand(p.get("id"), false); return Map.of();
            case "select": select(p.get("id")); return Map.of();
            case "focus": act(() -> comp(p.get("id")).requestFocusInWindow()); return Map.of();
            case "keys": keys(list(p.get("keys")), p.get("id")); return Map.of();
            case "typeText": typeText(String.valueOf(p.get("text")), p.get("id")); return Map.of();
            case "mouse": mouse(num(p.get("x")), num(p.get("y")), String.valueOf(p.getOrDefault("button", "left")), Boolean.TRUE.equals(p.get("double"))); return Map.of();
            case "screenshot": return Map.of("png", edt(() -> screenshot(p.get("window") == null ? null : window(p.get("window")))));
            case "cell": return Map.of("value", cell(p.get("id"), (int) num(p.get("row")), p.get("column"), p.containsKey("value") ? String.valueOf(p.get("value")) : null));
            case "treePath": treePath(p.get("id"), list(p.get("path")), String.valueOf(p.getOrDefault("op", "select"))); return Map.of();
            case "launch": throw new AgentException("not-supported", "the Java agent runs inside the application's JVM; EZTest starts the app with -javaagent");
            default: throw new AgentException("unknown-method", "unknown method " + method);
        }
    }

    private static double num(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        try {
            return Double.parseDouble(String.valueOf(o));
        } catch (NumberFormatException e) {
            throw new AgentException("invalid-argument", "expected a number, got " + o);
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> list(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List) for (Object x : (List<Object>) o) out.add(String.valueOf(x));
        return out;
    }

    // ------------------------------------------------------------------ tree

    private List<Map<String, Object>> windows() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Window w : Window.getWindows()) {
            if (!w.isShowing()) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", idOf(w));
            m.put("title", title(w));
            m.put("className", w.getClass().getName());
            out.add(m);
        }
        return out;
    }

    private static String title(Window w) {
        if (w instanceof java.awt.Frame) return String.valueOf(((java.awt.Frame) w).getTitle());
        if (w instanceof java.awt.Dialog) return String.valueOf(((java.awt.Dialog) w).getTitle());
        return "";
    }

    private Map<String, Object> elements(Window w) {
        List<Map<String, Object>> out = new ArrayList<>();
        seen.clear();
        walk(w, null, out);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("elements", out);
        if (out.size() >= MAX_ELEMENTS) m.put("truncated", true);
        return m;
    }

    private void walk(Component c, String parent, List<Map<String, Object>> out) {
        if (out.size() >= MAX_ELEMENTS || !seen.add(c)) return;
        Map<String, Object> e = describe(c, parent);
        out.add(e);
        String id = (String) e.get("id");
        if (c instanceof JTabbedPane) {
            JTabbedPane t = (JTabbedPane) c;
            for (int i = 0; i < t.getTabCount(); i++) {
                Map<String, Object> tab = new LinkedHashMap<>();
                tab.put("id", id + ":tab:" + i);
                tab.put("parent", id);
                tab.put("controlType", "TabItem");
                tab.put("name", t.getTitleAt(i));
                tab.put("framework", "Swing");
                tab.put("selected", t.getSelectedIndex() == i);
                tab.put("enabled", t.isEnabledAt(i));
                tab.put("visible", t.isShowing());
                Rectangle r = t.getBoundsAt(i);
                if (r != null && t.isShowing()) {
                    Point o = t.getLocationOnScreen();
                    tab.put("rect", rect(o.x + r.x, o.y + r.y, r.width, r.height));
                }
                out.add(tab);
            }
        }
        if (c instanceof JMenu) {
            for (Component k : ((JMenu) c).getMenuComponents()) walk(k, id, out);
            return;
        }
        if (c instanceof Container) for (Component k : ((Container) c).getComponents()) walk(k, id, out);
    }

    private static Map<String, Object> rect(int x, int y, int w, int h) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("x", x);
        r.put("y", y);
        r.put("width", w);
        r.put("height", h);
        return r;
    }

    static String controlType(Component c) {
        if (c instanceof Window) return "Window";
        if (c instanceof JCheckBox || c instanceof java.awt.Checkbox && ((java.awt.Checkbox) c).getCheckboxGroup() == null) return "CheckBox";
        if (c instanceof JRadioButton || c instanceof java.awt.Checkbox) return "RadioButton";
        if (c instanceof JMenu || c instanceof JMenuItem) return "MenuItem";
        if (c instanceof AbstractButton || c instanceof java.awt.Button) return "Button";
        if (c instanceof JPasswordField || c instanceof javax.swing.JTextField || c instanceof java.awt.TextField) return "Edit";
        if (c instanceof JTextArea || c instanceof JEditorPane || c instanceof java.awt.TextArea) return "Document";
        if (c instanceof JComboBox || c instanceof java.awt.Choice) return "ComboBox";
        if (c instanceof JLabel || c instanceof java.awt.Label) return "Text";
        if (c instanceof JList || c instanceof java.awt.List) return "List";
        if (c instanceof JTable) return "Table";
        if (c instanceof JTree) return "Tree";
        if (c instanceof JTabbedPane) return "Tab";
        if (c instanceof JMenuBar) return "MenuBar";
        if (c instanceof JPopupMenu) return "Menu";
        if (c instanceof JSlider) return "Slider";
        if (c instanceof JSpinner) return "Spinner";
        if (c instanceof JProgressBar) return "ProgressBar";
        if (c instanceof JToolBar) return "ToolBar";
        if (c instanceof JScrollBar) return "ScrollBar";
        if (c instanceof Container) return "Pane";
        return "Custom";
    }

    private static String strip(String s) {
        if (s == null) return null;
        return s.startsWith("<html>") ? s.replaceAll("<[^>]*>", " ").replaceAll("\\s+", " ").trim() : s;
    }

    private static String name(Component c) {
        String n = null;
        if (c instanceof AbstractButton) n = ((AbstractButton) c).getText();
        else if (c instanceof JLabel) n = ((JLabel) c).getText();
        else if (c instanceof Window) n = title((Window) c);
        else if (c instanceof java.awt.Button) n = ((java.awt.Button) c).getLabel();
        else if (c instanceof java.awt.Label) n = ((java.awt.Label) c).getText();
        else if (c instanceof java.awt.Checkbox) n = ((java.awt.Checkbox) c).getLabel();
        if (n == null || n.isEmpty()) {
            AccessibleContext ac = c.getAccessibleContext();
            String an = ac == null ? null : ac.getAccessibleName();
            if (an != null && !an.isEmpty()) n = an;
        }
        if ((n == null || n.isEmpty()) && c instanceof JComponent) n = ((JComponent) c).getToolTipText();
        return strip(n);
    }

    private Map<String, Object> describe(Component c, String parent) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", idOf(c));
        e.put("parent", parent);
        e.put("controlType", controlType(c));
        String n = name(c);
        if (n != null && !n.isEmpty()) e.put("name", n);
        if (c.getName() != null && !c.getName().isEmpty()) e.put("automationId", c.getName());
        e.put("className", c.getClass().getName());
        e.put("framework", c instanceof JComponent || c instanceof JFrame || c instanceof JDialog ? "Swing" : "AWT");
        if (c instanceof JComponent) {
            Object lb = ((JComponent) c).getClientProperty("labeledBy");
            if (lb instanceof JLabel && ((JLabel) lb).getText() != null) e.put("labeledBy", strip(((JLabel) lb).getText()));
        }
        String v = value(c, false);
        if (v != null) e.put("value", v);
        if (c instanceof JToggleButton) e.put("toggle", ((JToggleButton) c).isSelected() ? "on" : "off");
        if (c instanceof java.awt.Checkbox) e.put("toggle", ((java.awt.Checkbox) c).getState() ? "on" : "off");
        if (c instanceof JComboBox) e.put("expanded", ((JComboBox<?>) c).isPopupVisible());
        if (c instanceof JMenu) e.put("expanded", ((JMenu) c).isPopupMenuVisible());
        e.put("enabled", c.isEnabled());
        e.put("visible", c.isShowing());
        if (c.isShowing()) {
            Point o = c.getLocationOnScreen();
            e.put("rect", rect(o.x, o.y, c.getWidth(), c.getHeight()));
        }
        return e;
    }

    /** Value of a component; passwords only when `secret` (getValue for verification, never in the tree). */
    private static String value(Component c, boolean secret) {
        if (c instanceof JPasswordField) return secret ? new String(((JPasswordField) c).getPassword()) : null;
        if (c instanceof JTextComponent) return ((JTextComponent) c).getText();
        if (c instanceof JComboBox) {
            Object s = ((JComboBox<?>) c).getSelectedItem();
            return s == null ? "" : String.valueOf(s);
        }
        if (c instanceof JSpinner) return String.valueOf(((JSpinner) c).getValue());
        if (c instanceof JSlider) return String.valueOf(((JSlider) c).getValue());
        if (c instanceof JProgressBar) return String.valueOf(((JProgressBar) c).getValue());
        if (c instanceof java.awt.TextComponent) return ((java.awt.TextComponent) c).getText();
        if (c instanceof java.awt.Choice) return ((java.awt.Choice) c).getSelectedItem();
        if (secret && c instanceof JLabel) return ((JLabel) c).getText();
        if (secret && c instanceof AbstractButton) return ((AbstractButton) c).getText();
        return null;
    }

    // ------------------------------------------------------------------ actions

    private void invoke(Object id) {
        Component c = comp(id);
        int tab = tabIndex(id);
        if (tab >= 0) {
            act(() -> ((JTabbedPane) c).setSelectedIndex(tab));
            return;
        }
        if (!c.isEnabled()) throw new AgentException("disabled", controlType(c) + " \"" + name(c) + "\" is disabled");
        if (c instanceof JMenu) act(() -> ((JMenu) c).doClick(0));
        else if (c instanceof JMenuItem) act(() -> {
            ((JMenuItem) c).doClick(0);
            MenuSelectionManager.defaultManager().clearSelectedPath();
        });
        else if (c instanceof AbstractButton) act(() -> ((AbstractButton) c).doClick(0));
        else if (c instanceof JComboBox) act(() -> ((JComboBox<?>) c).showPopup());
        else if (c instanceof java.awt.Button) act(() -> {
            java.awt.Button b = (java.awt.Button) c;
            for (java.awt.event.ActionListener l : b.getActionListeners()) l.actionPerformed(new java.awt.event.ActionEvent(b, java.awt.event.ActionEvent.ACTION_PERFORMED, b.getActionCommand()));
        });
        else clickAt(c, c.getWidth() / 2, c.getHeight() / 2, MouseEvent.BUTTON1, 1);
    }

    private void setValue(Object id, String value) {
        Component c = comp(id);
        if (!c.isEnabled()) throw new AgentException("disabled", controlType(c) + " \"" + name(c) + "\" is disabled");
        if (c instanceof JTextComponent && !edt(((JTextComponent) c)::isEditable)) throw new AgentException("read-only", "the field is read-only");
        act(() -> {
            if (c instanceof JTextComponent) {
                ((JTextComponent) c).setText(value);
            } else if (c instanceof JComboBox) {
                JComboBox<?> cb = (JComboBox<?>) c;
                for (int i = 0; i < cb.getItemCount(); i++) {
                    if (String.valueOf(cb.getItemAt(i)).equals(value)) {
                        cb.setSelectedIndex(i);
                        return;
                    }
                }
                if (cb.isEditable()) cb.setSelectedItem(value);
            } else if (c instanceof JSpinner) {
                JSpinner s = (JSpinner) c;
                Object cur = s.getValue();
                s.setValue(cur instanceof Integer ? (Object) Integer.valueOf(value.trim()) : cur instanceof Double ? (Object) Double.valueOf(value.trim()) : value);
            } else if (c instanceof JSlider) ((JSlider) c).setValue(Integer.parseInt(value.trim()));
            else if (c instanceof java.awt.TextComponent) ((java.awt.TextComponent) c).setText(value);
            else if (c instanceof java.awt.Choice) ((java.awt.Choice) c).select(value);
        });
        String now = edt(() -> value(c, true));
        if (c instanceof JComboBox && !value.equals(now)) throw new AgentException("no-option", "\"" + value + "\" is not an option of the combo box");
    }

    private void toggle(Object id, String state) {
        Component c = comp(id);
        if (c instanceof AbstractButton) {
            AbstractButton b = (AbstractButton) c;
            boolean want = state == null ? !edt(b::isSelected) : "on".equals(state);
            if (edt(b::isSelected) != want) act(() -> b.doClick(0));
        } else if (c instanceof java.awt.Checkbox) {
            java.awt.Checkbox b = (java.awt.Checkbox) c;
            act(() -> b.setState(state == null ? !b.getState() : "on".equals(state)));
        } else throw new AgentException("not-supported", controlType(c) + " cannot be toggled");
    }

    private void expand(Object id, boolean open) {
        Component c = comp(id);
        if (c instanceof JMenu) act(() -> {
            JMenu m = (JMenu) c;
            if (open && !m.isPopupMenuVisible()) m.doClick(0);
            if (!open) MenuSelectionManager.defaultManager().clearSelectedPath();
        });
        else if (c instanceof JComboBox) act(() -> {
            if (open) ((JComboBox<?>) c).showPopup(); else ((JComboBox<?>) c).hidePopup();
        });
        else throw new AgentException("not-supported", controlType(c) + " cannot be expanded");
    }

    private void select(Object id) {
        Component c = comp(id);
        int tab = tabIndex(id);
        if (tab >= 0) act(() -> ((JTabbedPane) c).setSelectedIndex(tab));
        else if (c instanceof AbstractButton) act(() -> ((AbstractButton) c).doClick(0));
        else throw new AgentException("not-supported", controlType(c) + " cannot be selected");
    }

    private static final Map<String, Integer> KEYS = new HashMap<>();
    static {
        KEYS.put("ENTER", KeyEvent.VK_ENTER); KEYS.put("TAB", KeyEvent.VK_TAB); KEYS.put("ESCAPE", KeyEvent.VK_ESCAPE);
        KEYS.put("BACKSPACE", KeyEvent.VK_BACK_SPACE); KEYS.put("DELETE", KeyEvent.VK_DELETE); KEYS.put("SPACE", KeyEvent.VK_SPACE);
        KEYS.put("UP", KeyEvent.VK_UP); KEYS.put("DOWN", KeyEvent.VK_DOWN); KEYS.put("LEFT", KeyEvent.VK_LEFT); KEYS.put("RIGHT", KeyEvent.VK_RIGHT);
        KEYS.put("HOME", KeyEvent.VK_HOME); KEYS.put("END", KeyEvent.VK_END); KEYS.put("PAGEUP", KeyEvent.VK_PAGE_UP); KEYS.put("PAGEDOWN", KeyEvent.VK_PAGE_DOWN);
        KEYS.put("INSERT", KeyEvent.VK_INSERT);
        for (int i = 1; i <= 12; i++) KEYS.put("F" + i, KeyEvent.VK_F1 + i - 1);
    }

    private Component focusTarget(Object id) {
        if (id != null) return comp(id);
        Component f = edt(() -> KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner());
        if (f != null) return f;
        Window a = edt(() -> KeyboardFocusManager.getCurrentKeyboardFocusManager().getActiveWindow());
        if (a != null) return a;
        for (Window w : Window.getWindows()) if (w.isShowing()) return w;
        throw new AgentException("no-window", "no window to send keys to");
    }

    private void keys(List<String> keys, Object id) {
        Component target = focusTarget(id);
        int mods = 0;
        Integer code = null;
        char ch = KeyEvent.CHAR_UNDEFINED;
        for (String k : keys) {
            switch (k) {
                case "CTRL": mods |= InputEvent.CTRL_DOWN_MASK; break;
                case "ALT": mods |= InputEvent.ALT_DOWN_MASK; break;
                case "SHIFT": mods |= InputEvent.SHIFT_DOWN_MASK; break;
                case "WIN": mods |= InputEvent.META_DOWN_MASK; break;
                default:
                    if (KEYS.containsKey(k)) {
                        code = KEYS.get(k);
                        if ("ENTER".equals(k)) ch = '\n';
                        if ("TAB".equals(k)) ch = '\t';
                        if ("SPACE".equals(k)) ch = ' ';
                    } else if (k.length() == 1) {
                        ch = k.charAt(0);
                        code = KeyEvent.getExtendedKeyCodeForChar(Character.toLowerCase(ch));
                        if ((mods & InputEvent.SHIFT_DOWN_MASK) == 0) ch = Character.toLowerCase(ch);
                    } else throw new AgentException("invalid-argument", "unknown key " + k);
            }
        }
        if (code == null) throw new AgentException("invalid-argument", "no key in " + keys);
        final int m = mods;
        final int kc = code;
        final char c = ch;
        act(() -> {
            // Key events are delivered to the component itself (listeners and key bindings), not through the
            // focus manager: a test display often has no window manager to give the window focus.
            long now = System.currentTimeMillis();
            deliver(target, new KeyEvent(target, KeyEvent.KEY_PRESSED, now, m, kc, c));
            if (c != KeyEvent.CHAR_UNDEFINED && c >= ' ' && (m & (InputEvent.CTRL_DOWN_MASK | InputEvent.ALT_DOWN_MASK)) == 0) {
                if (target instanceof JTextComponent && ((JTextComponent) target).isEditable()) ((JTextComponent) target).replaceSelection(String.valueOf(c));
                else deliver(target, new KeyEvent(target, KeyEvent.KEY_TYPED, now, m, KeyEvent.VK_UNDEFINED, c));
            }
            deliver(target, new KeyEvent(target, KeyEvent.KEY_RELEASED, now, m, kc, c));
        });
    }

    private static void deliver(Component target, KeyEvent e) {
        for (java.awt.event.KeyListener l : target.getKeyListeners()) {
            if (e.getID() == KeyEvent.KEY_PRESSED) l.keyPressed(e);
            else if (e.getID() == KeyEvent.KEY_RELEASED) l.keyReleased(e);
            else l.keyTyped(e);
        }
        if (e.isConsumed() || SwingUtilities.processKeyBindings(e)) return;
        // Text actions are only enabled for the focused text component; without focus, do what they would do.
        boolean plain = (e.getModifiersEx() & (InputEvent.CTRL_DOWN_MASK | InputEvent.ALT_DOWN_MASK | InputEvent.META_DOWN_MASK)) == 0;
        if (e.getID() == KeyEvent.KEY_PRESSED && plain && e.getKeyCode() == KeyEvent.VK_ENTER && target instanceof javax.swing.JTextField) ((javax.swing.JTextField) target).postActionEvent();
        else if (e.getID() == KeyEvent.KEY_PRESSED && plain && (e.getKeyCode() == KeyEvent.VK_SPACE || e.getKeyCode() == KeyEvent.VK_ENTER) && target instanceof AbstractButton) ((AbstractButton) target).doClick(0);
    }

    private void typeText(String text, Object id) {
        Component target = focusTarget(id);
        act(() -> {
            if (target instanceof JTextComponent) {
                ((JTextComponent) target).replaceSelection(text);
                return;
            }
            long now = System.currentTimeMillis();
            for (char c : text.toCharArray()) deliver(target, new KeyEvent(target, KeyEvent.KEY_TYPED, now, 0, KeyEvent.VK_UNDEFINED, c));
        });
    }

    private void mouse(double x, double y, String button, boolean dbl) {
        Component hit = edt(() -> {
            for (Window w : Window.getWindows()) {
                if (!w.isShowing()) continue;
                Point o = w.getLocationOnScreen();
                if (new Rectangle(o.x, o.y, w.getWidth(), w.getHeight()).contains(x, y)) {
                    Component deep = SwingUtilities.getDeepestComponentAt(w, (int) x - o.x, (int) y - o.y);
                    return deep == null ? w : deep;
                }
            }
            return null;
        });
        if (hit == null) throw new AgentException("no-element", "nothing at " + (int) x + "," + (int) y);
        Point o = edt(hit::getLocationOnScreen);
        int b = "right".equals(button) ? MouseEvent.BUTTON3 : "middle".equals(button) ? MouseEvent.BUTTON2 : MouseEvent.BUTTON1;
        clickAt(hit, (int) x - o.x, (int) y - o.y, b, dbl ? 2 : 1);
    }

    private void clickAt(Component c, int x, int y, int button, int count) {
        int mask = button == MouseEvent.BUTTON3 ? InputEvent.BUTTON3_DOWN_MASK : button == MouseEvent.BUTTON2 ? InputEvent.BUTTON2_DOWN_MASK : InputEvent.BUTTON1_DOWN_MASK;
        act(() -> {
            for (int n = 1; n <= count; n++) {
                long now = System.currentTimeMillis();
                c.dispatchEvent(new MouseEvent(c, MouseEvent.MOUSE_PRESSED, now, mask, x, y, n, button == MouseEvent.BUTTON3, button));
                c.dispatchEvent(new MouseEvent(c, MouseEvent.MOUSE_RELEASED, now, 0, x, y, n, false, button));
                c.dispatchEvent(new MouseEvent(c, MouseEvent.MOUSE_CLICKED, now, 0, x, y, n, false, button));
            }
        });
    }

    /** PNG (base64) painted from the component tree: works without a screen grabber, also under Xvfb. */
    private String screenshot(Window w) {
        BufferedImage img;
        if (w != null) {
            img = new BufferedImage(Math.max(1, w.getWidth()), Math.max(1, w.getHeight()), BufferedImage.TYPE_INT_RGB);
            Graphics2D g = img.createGraphics();
            w.printAll(g);
            g.dispose();
        } else {
            Dimension d = Toolkit.getDefaultToolkit().getScreenSize();
            img = new BufferedImage(Math.max(1, d.width), Math.max(1, d.height), BufferedImage.TYPE_INT_RGB);
            Graphics2D g = img.createGraphics();
            for (Window x : Window.getWindows()) {
                if (!x.isShowing()) continue;
                Point o = x.getLocationOnScreen();
                Graphics2D gx = (Graphics2D) g.create(o.x, o.y, x.getWidth(), x.getHeight());
                x.printAll(gx);
                gx.dispose();
            }
            g.dispose();
        }
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            ImageIO.write(img, "png", b);
            return Base64.getEncoder().encodeToString(b.toByteArray());
        } catch (java.io.IOException e) {
            throw new AgentException("error", "could not encode the screenshot: " + e.getMessage());
        }
    }

    /** Table cell (rows and numeric columns are 1-based; a column may be a header name). */
    private String cell(Object id, int row, Object column, String set) {
        Component c = comp(id);
        if (c instanceof JList) {
            JList<?> l = (JList<?>) c;
            return edt(() -> {
                if (row < 1 || row > l.getModel().getSize()) throw new AgentException("no-cell", "row " + row + " is outside 1.." + l.getModel().getSize());
                if (set != null) throw new AgentException("not-supported", "list items are read-only");
                return String.valueOf(l.getModel().getElementAt(row - 1));
            });
        }
        if (!(c instanceof JTable)) throw new AgentException("not-supported", controlType(c) + " has no cells");
        JTable t = (JTable) c;
        int col = edt(() -> {
            String cs = String.valueOf(column);
            for (int i = 0; i < t.getColumnCount(); i++) if (t.getColumnName(i).equalsIgnoreCase(cs.trim())) return i;
            if (cs.matches("\\d+")) return Integer.parseInt(cs) - 1;
            throw new AgentException("no-cell", "no column \"" + cs + "\"");
        });
        int rows = edt(t::getRowCount);
        if (row < 1 || row > rows) throw new AgentException("no-cell", "row " + row + " is outside 1.." + rows);
        if (set != null) {
            act(() -> {
                if (t.isEditing()) t.getCellEditor().stopCellEditing();
                t.setValueAt(set, row - 1, col);
            });
        }
        return edt(() -> {
            Object v = t.getValueAt(row - 1, col);
            return v == null ? "" : String.valueOf(v);
        });
    }

    private void treePath(Object id, List<String> path, String op) {
        Component c = comp(id);
        if (!(c instanceof JTree)) throw new AgentException("not-supported", controlType(c) + " is not a tree");
        JTree tree = (JTree) c;
        TreePath tp = edt(() -> {
            TreeModel m = tree.getModel();
            Object node = m.getRoot();
            List<Object> nodes = new ArrayList<>();
            nodes.add(node);
            int start = 0;
            if (!path.isEmpty() && String.valueOf(node).equals(path.get(0))) start = 1;
            for (int k = start; k < path.size(); k++) {
                Object found = null;
                for (int i = 0; i < m.getChildCount(node); i++) {
                    Object ch = m.getChild(node, i);
                    if (String.valueOf(ch).equals(path.get(k))) { found = ch; break; }
                }
                if (found == null) throw new AgentException("no-element", "tree has no \"" + path.get(k) + "\" under \"" + node + "\"");
                nodes.add(found);
                node = found;
            }
            return new TreePath(nodes.toArray());
        });
        act(() -> {
            if ("collapse".equals(op)) tree.collapsePath(tp);
            else {
                tree.expandPath("expand".equals(op) ? tp : tp.getParentPath() == null ? tp : tp.getParentPath());
                if ("expand".equals(op)) tree.expandPath(tp);
                if ("select".equals(op)) tree.setSelectionPath(tp);
                tree.scrollPathToVisible(tp);
            }
        });
    }
}
