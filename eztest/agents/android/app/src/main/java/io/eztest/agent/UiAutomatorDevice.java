package io.eztest.agent;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import io.eztest.agent.core.AgentError;
import io.eztest.agent.core.Device;
import io.eztest.agent.core.Snapshot;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * The Android Device: androidx.test.uiautomator's UiDevice for keys,
 * orientation and the notification shade; UiAutomation for the accessibility
 * tree (the hierarchy is built here, tags are class names), screenshots and
 * injected touch events (multi-finger gestures from finger paths).
 */
public final class UiAutomatorDevice implements Device {
    private final Instrumentation instrumentation;
    private final UiDevice ui;
    private final UiAutomation automation;
    private final Context context;

    public UiAutomatorDevice(Instrumentation instrumentation) {
        this.instrumentation = instrumentation;
        this.ui = UiDevice.getInstance(instrumentation);
        this.automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        this.context = instrumentation.getTargetContext();
    }

    // ------------------------------------------------------------------ hierarchy
    private List<AccessibilityNodeInfo> roots() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        for (AccessibilityWindowInfo w : automation.getWindows()) {
            AccessibilityNodeInfo r = w.getRoot();
            if (r != null) out.add(r);
        }
        if (out.isEmpty()) {
            AccessibilityNodeInfo r = automation.getRootInActiveWindow();
            if (r != null) out.add(r);
        }
        return out;
    }

    @Override
    public Snapshot snapshot() throws Exception {
        StringBuilder xml = new StringBuilder();
        List<Object> handles = new ArrayList<>();
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy rotation=\"").append(ui.getDisplayRotation())
            .append("\" width=\"").append(ui.getDisplayWidth()).append("\" height=\"").append(ui.getDisplayHeight()).append("\">");
        for (AccessibilityNodeInfo r : roots()) dump(r, 0, xml, handles, 0);
        xml.append("</hierarchy>");
        return new Snapshot(xml.toString(), handles);
    }

    private static String b(boolean v) {
        return v ? "true" : "false";
    }

    private void dump(AccessibilityNodeInfo n, int index, StringBuilder xml, List<Object> handles, int depth) {
        if (n == null || depth > 80) return;
        String tag = Snapshot.tag(n.getClassName() == null ? null : n.getClassName().toString());
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        handles.add(n);
        xml.append('<').append(tag);
        attr(xml, "index", String.valueOf(index));
        attr(xml, "text", n.getText() == null ? "" : n.getText().toString());
        attr(xml, "resource-id", n.getViewIdResourceName() == null ? "" : n.getViewIdResourceName());
        attr(xml, "class", n.getClassName() == null ? "" : n.getClassName().toString());
        attr(xml, "package", n.getPackageName() == null ? "" : n.getPackageName().toString());
        attr(xml, "content-desc", n.getContentDescription() == null ? "" : n.getContentDescription().toString());
        if (Build.VERSION.SDK_INT >= 26 && n.getHintText() != null) attr(xml, "hint", n.getHintText().toString());
        attr(xml, "checkable", b(n.isCheckable()));
        attr(xml, "checked", b(n.isChecked()));
        attr(xml, "clickable", b(n.isClickable()));
        attr(xml, "enabled", b(n.isEnabled()));
        attr(xml, "focusable", b(n.isFocusable()));
        attr(xml, "focused", b(n.isFocused()));
        attr(xml, "scrollable", b(n.isScrollable()));
        attr(xml, "long-clickable", b(n.isLongClickable()));
        attr(xml, "password", b(n.isPassword()));
        attr(xml, "selected", b(n.isSelected()));
        attr(xml, "displayed", b(n.isVisibleToUser()));
        attr(xml, "bounds", "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]");
        int count = n.getChildCount();
        if (count == 0) {
            xml.append("/>");
            return;
        }
        xml.append('>');
        for (int i = 0; i < count; i++) dump(n.getChild(i), i, xml, handles, depth + 1);
        xml.append("</").append(tag).append('>');
    }

    private static void attr(StringBuilder xml, String k, String v) {
        xml.append(' ').append(k).append("=\"").append(Snapshot.attr(v)).append('"');
    }

    private static AccessibilityNodeInfo node(Object h) {
        AccessibilityNodeInfo n = (AccessibilityNodeInfo) h;
        if (!n.refresh()) throw AgentError.stale(String.valueOf(n.getViewIdResourceName()));
        return n;
    }

    // ------------------------------------------------------------------ elements
    @Override
    public void click(Object h) {
        AccessibilityNodeInfo n = node(h);
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        // A real tap at the centre (what a user does); ACTION_CLICK alone skips touch listeners.
        if (!ui.click(r.centerX(), r.centerY()) && !n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw new AgentError(500, "internal", "tap was not delivered");
    }

    @Override
    public void clear(Object h) {
        AccessibilityNodeInfo n = node(h);
        android.os.Bundle args = new android.os.Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw AgentError.invalid("element is not editable");
    }

    @Override
    public void type(Object h, String text) {
        AccessibilityNodeInfo n = node(h);
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        String current = n.isPassword() || n.getText() == null || (n.getHintText() != null && n.getText().toString().contentEquals(n.getHintText())) ? "" : n.getText().toString();
        android.os.Bundle args = new android.os.Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, current + text);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw AgentError.invalid("element is not editable");
    }

    @Override
    public String text(Object h) {
        CharSequence t = node(h).getText();
        return t == null ? "" : t.toString();
    }

    @Override
    public String attribute(Object h, String name) {
        AccessibilityNodeInfo n = node(h);
        switch (name) {
            case "text": return n.getText() == null ? null : n.getText().toString();
            case "resource-id": return n.getViewIdResourceName();
            case "content-desc": return n.getContentDescription() == null ? null : n.getContentDescription().toString();
            case "class": return n.getClassName() == null ? null : n.getClassName().toString();
            case "package": return n.getPackageName() == null ? null : n.getPackageName().toString();
            case "hint": return n.getHintText() == null ? null : n.getHintText().toString();
            case "checkable": return b(n.isCheckable());
            case "checked": return b(n.isChecked());
            case "clickable": return b(n.isClickable());
            case "enabled": return b(n.isEnabled());
            case "focusable": return b(n.isFocusable());
            case "focused": return b(n.isFocused());
            case "scrollable": return b(n.isScrollable());
            case "long-clickable": return b(n.isLongClickable());
            case "password": return b(n.isPassword());
            case "selected": return b(n.isSelected());
            case "displayed": return b(n.isVisibleToUser());
            default: return null;
        }
    }

    @Override
    public int[] rect(Object h) {
        Rect r = new Rect();
        node(h).getBoundsInScreen(r);
        return new int[] { r.left, r.top, r.width(), r.height() };
    }

    @Override
    public boolean displayed(Object h) {
        return node(h).isVisibleToUser();
    }

    @Override
    public boolean enabled(Object h) {
        return node(h).isEnabled();
    }

    @Override
    public boolean selected(Object h) {
        AccessibilityNodeInfo n = node(h);
        return n.isSelected() || n.isChecked();
    }

    // ------------------------------------------------------------------ screen and input
    @Override
    public byte[] screenshotPng() {
        Bitmap bmp = automation.takeScreenshot();
        if (bmp == null) throw new AgentError(500, "internal", "screenshot failed (secure window?)");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
        bmp.recycle();
        return out.toByteArray();
    }

    @Override
    public int[] window() {
        return new int[] { 0, 0, ui.getDisplayWidth(), ui.getDisplayHeight() };
    }

    /** Inject finger paths as MotionEvents (10 ms steps; fingers come and go by their own timelines). */
    @Override
    public void gesture(List<List<long[]>> fingers) throws Exception {
        TreeSet<Long> times = new TreeSet<>();
        long end = 0;
        for (List<long[]> f : fingers) {
            long t0 = f.get(0)[2];
            long t1 = f.get(f.size() - 1)[2];
            for (long t = t0; t <= t1; t += 10) times.add(t);
            times.add(t1);
            end = Math.max(end, t1);
        }
        long downTime = SystemClock.uptimeMillis();
        boolean[] down = new boolean[fingers.size()];
        float[][] last = new float[fingers.size()][2];
        long start = SystemClock.uptimeMillis();
        for (long t : times) {
            long wait = start + t - SystemClock.uptimeMillis();
            if (wait > 0) SystemClock.sleep(wait);
            for (int i = 0; i < fingers.size(); i++) {
                List<long[]> f = fingers.get(i);
                long t0 = f.get(0)[2];
                long t1 = f.get(f.size() - 1)[2];
                float[] p = position(f, t);
                if (!down[i] && t >= t0 && t <= t1) {
                    down[i] = true;
                    last[i] = p;
                    inject(downTime, active(down) == 1 ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_POINTER_DOWN | (index(down, i) << MotionEvent.ACTION_POINTER_INDEX_SHIFT), down, last);
                } else if (down[i] && t < t1) {
                    last[i] = p;
                }
            }
            if (active(down) > 0) inject(downTime, MotionEvent.ACTION_MOVE, down, last);
            for (int i = 0; i < fingers.size(); i++) {
                List<long[]> f = fingers.get(i);
                if (down[i] && t >= f.get(f.size() - 1)[2]) {
                    last[i] = position(f, t);
                    inject(downTime, active(down) == 1 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_POINTER_UP | (index(down, i) << MotionEvent.ACTION_POINTER_INDEX_SHIFT), down, last);
                    down[i] = false;
                }
            }
        }
    }

    private static int active(boolean[] down) {
        int n = 0;
        for (boolean d : down) if (d) n++;
        return n;
    }

    private static int index(boolean[] down, int finger) {
        int n = 0;
        for (int i = 0; i < finger; i++) if (down[i]) n++;
        return n;
    }

    private static float[] position(List<long[]> f, long t) {
        long[] prev = f.get(0);
        for (long[] p : f) {
            if (p[2] >= t) {
                if (p[2] == prev[2]) return new float[] { p[0], p[1] };
                float k = (float) (t - prev[2]) / (float) (p[2] - prev[2]);
                return new float[] { prev[0] + k * (p[0] - prev[0]), prev[1] + k * (p[1] - prev[1]) };
            }
            prev = p;
        }
        long[] l = f.get(f.size() - 1);
        return new float[] { l[0], l[1] };
    }

    private void inject(long downTime, int action, boolean[] down, float[][] pos) {
        int n = active(down);
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[n];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[n];
        int k = 0;
        for (int i = 0; i < down.length; i++) {
            if (!down[i]) continue;
            props[k] = new MotionEvent.PointerProperties();
            props[k].id = i;
            props[k].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[k] = new MotionEvent.PointerCoords();
            coords[k].x = pos[i][0];
            coords[k].y = pos[i][1];
            coords[k].pressure = 1;
            coords[k].size = 1;
            k++;
        }
        MotionEvent e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, n, props, coords, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        automation.injectInputEvent(e, true);
        e.recycle();
    }

    private static final Map<String, Integer> KEYS = new HashMap<>();
    static {
        KEYS.put("enter", KeyEvent.KEYCODE_ENTER);
        KEYS.put("return", KeyEvent.KEYCODE_ENTER);
        KEYS.put("tab", KeyEvent.KEYCODE_TAB);
        KEYS.put("backspace", KeyEvent.KEYCODE_DEL);
        KEYS.put("delete", KeyEvent.KEYCODE_FORWARD_DEL);
        KEYS.put("space", KeyEvent.KEYCODE_SPACE);
        KEYS.put("escape", KeyEvent.KEYCODE_ESCAPE);
        KEYS.put("esc", KeyEvent.KEYCODE_ESCAPE);
        KEYS.put("back", KeyEvent.KEYCODE_BACK);
        KEYS.put("home", KeyEvent.KEYCODE_HOME);
        KEYS.put("menu", KeyEvent.KEYCODE_MENU);
        KEYS.put("search", KeyEvent.KEYCODE_SEARCH);
        KEYS.put("arrowup", KeyEvent.KEYCODE_DPAD_UP);
        KEYS.put("arrowdown", KeyEvent.KEYCODE_DPAD_DOWN);
        KEYS.put("arrowleft", KeyEvent.KEYCODE_DPAD_LEFT);
        KEYS.put("arrowright", KeyEvent.KEYCODE_DPAD_RIGHT);
        KEYS.put("pageup", KeyEvent.KEYCODE_PAGE_UP);
        KEYS.put("pagedown", KeyEvent.KEYCODE_PAGE_DOWN);
        KEYS.put("volume_up", KeyEvent.KEYCODE_VOLUME_UP);
        KEYS.put("volume_down", KeyEvent.KEYCODE_VOLUME_DOWN);
        KEYS.put("power", KeyEvent.KEYCODE_POWER);
        KEYS.put("app_switch", KeyEvent.KEYCODE_APP_SWITCH);
    }

    @Override
    public void key(String key) {
        String k = key.toLowerCase().replaceAll("[\\s-]", "");
        Integer code = KEYS.get(k);
        if (code == null && k.length() == 1) {
            keys(key);
            return;
        }
        if (code == null) throw AgentError.invalid("unknown key \"" + key + "\"");
        if (!ui.pressKeyCode(code)) throw new AgentError(500, "internal", "key " + key + " was not delivered");
    }

    @Override
    public void keys(String text) {
        UiObject2 focused = ui.findObject(By.focused(true));
        if (focused == null) throw AgentError.invalid("no focused element to type into");
        String current = focused.getText() == null ? "" : focused.getText();
        focused.setText(current + text);
    }

    @Override
    public String orientation() {
        int r = ui.getDisplayRotation();
        return r == android.view.Surface.ROTATION_90 || r == android.view.Surface.ROTATION_270 ? "landscape" : "portrait";
    }

    @Override
    public void setOrientation(String value) throws Exception {
        if (value.equals("landscape")) ui.setOrientationLeft();
        else ui.setOrientationNatural();
    }

    // ------------------------------------------------------------------ system alerts (dialogs and permission prompts)
    private static final String[] ALERT_TEXT = { "android:id/message", "com.android.permissioncontroller:id/permission_message", "com.android.packageinstaller:id/permission_message", "android:id/alertTitle" };
    private static final String[] ALERT_ACCEPT = { "com.android.permissioncontroller:id/permission_allow_foreground_only_button", "com.android.permissioncontroller:id/permission_allow_button", "com.android.permissioncontroller:id/permission_allow_one_time_button", "android:id/button1" };
    private static final String[] ALERT_DISMISS = { "com.android.permissioncontroller:id/permission_deny_button", "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button", "android:id/button2" };

    private UiObject2 first(String[] ids) {
        for (String id : ids) {
            UiObject2 o = ui.findObject(By.res(id));
            if (o != null) return o;
        }
        return null;
    }

    @Override
    public String alertText() {
        UiObject2 o = first(ALERT_TEXT);
        return o == null ? null : o.getText();
    }

    @Override
    public void acceptAlert() {
        UiObject2 b = first(ALERT_ACCEPT);
        if (b == null) throw new AgentError(404, "no such alert", "no accept button on the open alert");
        b.click();
    }

    @Override
    public void dismissAlert() {
        UiObject2 b = first(ALERT_DISMISS);
        if (b == null) throw new AgentError(404, "no such alert", "no dismiss button on the open alert");
        b.click();
    }

    @Override
    public void hideKeyboard() {
        for (AccessibilityWindowInfo w : automation.getWindows()) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                ui.pressBack();
                return;
            }
        }
    }

    // ------------------------------------------------------------------ apps and device
    private String shell(String cmd) throws Exception {
        ParcelFileDescriptor pfd = automation.executeShellCommand(cmd);
        try (InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            pfd.close();
        }
    }

    @Override
    public void app(String op, String appId) throws Exception {
        switch (op) {
            case "launch":
            case "activate": {
                Intent i = context.getPackageManager().getLaunchIntentForPackage(appId);
                if (i == null) throw AgentError.invalid("app " + appId + " is not installed or has no launcher activity");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | (op.equals("launch") ? Intent.FLAG_ACTIVITY_CLEAR_TASK : Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
                context.startActivity(i);
                ui.wait(androidx.test.uiautomator.Until.hasObject(By.pkg(appId).depth(0)), 10_000);
                return;
            }
            case "terminate":
                shell("am force-stop " + appId.replaceAll("[^A-Za-z0-9._]", ""));
                return;
            default:
                throw AgentError.invalid("unknown app operation " + op);
        }
    }

    @Override
    public void background(double seconds) throws Exception {
        String pkg = ui.getCurrentPackageName();
        ui.pressHome();
        if (seconds < 0) return;
        SystemClock.sleep((long) (seconds * 1000));
        if (pkg != null) app("activate", pkg);
    }

    @Override
    public void deepLink(String url, String appId) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        if (appId != null) i.setPackage(appId);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(i);
    }

    @Override
    public void openNotifications() {
        ui.openNotification();
    }

    @Override
    public void lock(Double seconds) throws Exception {
        ui.sleep();
        if (seconds != null) {
            SystemClock.sleep((long) (seconds * 1000));
            unlock();
        }
    }

    @Override
    public void unlock() throws Exception {
        ui.wakeUp();
        shell("wm dismiss-keyguard");
    }

    @Override
    public void geolocation(double latitude, double longitude) {
        throw AgentError.notSupported("setting the location (allow mock locations for io.eztest.agent first)");
    }

    @Override
    public void shake() {
        throw AgentError.notSupported("shaking the device");
    }

    @Override
    public Map<String, Object> info() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("model", Build.MODEL);
        m.put("manufacturer", Build.MANUFACTURER);
        m.put("sdk", Build.VERSION.SDK_INT);
        m.put("release", Build.VERSION.RELEASE);
        m.put("width", ui.getDisplayWidth());
        m.put("height", ui.getDisplayHeight());
        return m;
    }
}
