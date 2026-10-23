package io.eztest.agent.core;

import java.io.File;

/** Serves the real agent Router + HttpServer over a fixture hierarchy: `java io.eztest.agent.core.FixtureAgentMain <fixture.xml> [port]`. */
public final class FixtureAgentMain {
    public static void main(String[] args) throws Exception {
        FixtureDevice device = new FixtureDevice(new File(args[0]));
        HttpServer server = new HttpServer(new Router(device, "eztest-android"), args.length > 1 ? Integer.parseInt(args[1]) : 0);
        System.out.println("EZTEST_AGENT_LISTENING " + server.port());
        System.out.flush();
        server.serve();
    }
}
