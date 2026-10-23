package io.eztest.agent.core;

/** An agent protocol error: HTTP status + code ("no such element", "stale element", "invalid argument", "not supported", "unknown command", "timeout", "internal"). */
public class AgentError extends RuntimeException {
    private static final long serialVersionUID = 1L;
    public final int status;
    public final String code;

    public AgentError(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public static AgentError notSupported(String what) {
        return new AgentError(501, "not supported", what + " is not supported on this device");
    }

    public static AgentError invalid(String message) {
        return new AgentError(400, "invalid argument", message);
    }

    public static AgentError stale(String id) {
        return new AgentError(404, "stale element", "element " + id + " is no longer on screen");
    }
}
