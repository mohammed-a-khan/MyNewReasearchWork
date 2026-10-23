package io.eztest.agent.core;

import java.util.List;
import java.util.Map;

/**
 * What the agent needs from a device. The Android implementation is
 * UiAutomatorDevice (androidx.test.uiautomator + UiAutomation); tests use a
 * fixture device over an XML hierarchy. Element handles are opaque objects
 * produced by {@link #snapshot()}; an operation on a handle that is no longer
 * on screen throws {@link AgentError#stale}. Unsupported operations throw
 * {@link AgentError#notSupported}.
 */
public interface Device {
    /** The current UI hierarchy: XML (EZTest format) + one handle per element node, in document order. */
    Snapshot snapshot() throws Exception;

    void click(Object h) throws Exception;
    void clear(Object h) throws Exception;
    void type(Object h, String text) throws Exception;
    String text(Object h) throws Exception;
    /** An attribute of the element as in the hierarchy (text, resource-id, checked, ...); null when absent. */
    String attribute(Object h, String name) throws Exception;
    /** x, y, width, height in screen pixels. */
    int[] rect(Object h) throws Exception;
    boolean displayed(Object h) throws Exception;
    boolean enabled(Object h) throws Exception;
    boolean selected(Object h) throws Exception;

    byte[] screenshotPng() throws Exception;
    /** x, y, width, height of the screen. */
    int[] window() throws Exception;
    /** Fingers: each a list of {x, y, t} points (t in ms from the gesture start). */
    void gesture(List<List<long[]>> fingers) throws Exception;
    void key(String key) throws Exception;
    void keys(String text) throws Exception;
    String orientation() throws Exception;
    void setOrientation(String value) throws Exception;
    /** Text of an open system alert, or null. */
    String alertText() throws Exception;
    void acceptAlert() throws Exception;
    void dismissAlert() throws Exception;
    void hideKeyboard() throws Exception;
    void app(String op, String appId) throws Exception;
    void background(double seconds) throws Exception;
    void deepLink(String url, String appId) throws Exception;
    void openNotifications() throws Exception;
    void lock(Double seconds) throws Exception;
    void unlock() throws Exception;
    void geolocation(double latitude, double longitude) throws Exception;
    void shake() throws Exception;
    /** Facts for /status (model, sdk, ...). */
    Map<String, Object> info();
}
